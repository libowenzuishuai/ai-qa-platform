"""Opt-in real Kimi evaluation of synthetic public fixtures; never part of default tests.

Runs five rule samples and one case-generation sample, without automatic retries.
Saves inputs, outputs, semantic checks and actual invocation metadata for TS revalidation.
No private project files or credentials are written to the report.
"""
import argparse
import asyncio
import copy
import hashlib
import json
import os
import shlex
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory

from aiqa_intelligence.agents.service import AgentPipelines
from aiqa_intelligence.context import RequestContext
from aiqa_intelligence.contracts.generated import RuleExtractionInput, CaseGenerationInput
from aiqa_intelligence.errors import ServiceError
from aiqa_intelligence.models import Gateway
from aiqa_intelligence.storage import ArtifactReader

REPO = Path(__file__).resolve().parents[3]
FIXTURES = REPO / "packages/contracts/fixtures"
NAMES = ["01-explicit-prd", "02-conflict-prd", "03-missing-boundary", "04-pdf-vision-parsed", "05-pdf-vision-low"]


def load_env(path: Path):
    # Parse values as data; do not source a shell file or print credentials.
    for line in path.read_text().splitlines():
        if line.startswith("AIQA_TEXT_") and "=" in line:
            key, value = line.split("=", 1)
            parts = shlex.split(value, comments=True)
            if parts:
                os.environ[key] = parts[0]


def check_rules(name, output):
    drafts = output["ruleDrafts"]
    if name == "01-explicit-prd":
        assert any(d["classification"] == "EXPLICIT" and any(f.get("operator") == "gt" and f.get("value") == 500000 and f.get("unit") == "fen" for f in d.get("businessFields", [])) for d in drafts), "5000 元严格大于边界未保留为 500000 fen / gt"
        assert any("自己" in json.dumps(d, ensure_ascii=False) for d in drafts), "自审批权限限制未保留"
    elif name == "02-conflict-prd":
        assert len(drafts) == 2, "冲突应保留双方，不新增调和规则"
        assert all(d["classification"] == "EXPLICIT" and d.get("sources") and d.get("conflictsWith") for d in drafts), "冲突双方缺来源或互指"
        assert any(c["kind"] == "CONFLICT" and set(c["ruleDraftKeys"]) == {d["key"] for d in drafts} for c in output["clarifications"]), "缺少关联双方的 CONFLICT 澄清"
    elif name == "03-missing-boundary":
        boundary = [d for d in drafts if d["classification"] == "UNKNOWN"]
        assert boundary, "未知边界未标 UNKNOWN"
        assert all(not isinstance(f.get("value"), (int, float)) for d in boundary for f in d.get("businessFields", [])), "编造缺失的金额边界"
        assert any(c["kind"] == "MISSING_INFO" and set(c["ruleDraftKeys"]) & {d["key"] for d in boundary} for c in output["clarifications"]), "缺少金额边界澄清"
    elif name == "04-pdf-vision-parsed":
        assert "vspan-2" in {r["spanId"] for r in output["unparsedRanges"]}, "遗漏未识别区域"
        assert drafts and all("vspan-2" not in src["sourceSpanIds"] for d in drafts for src in d.get("sources", [])), "未识别区域被当作来源"
    else:
        assert drafts and all(d["classification"] in {"INFERRED", "UNKNOWN"} for d in drafts), "LOW 转录冒充已确认原文"
        assert output["clarifications"], "低质量转录没有请求核对"


async def verify(args):
    report = {"mode": "real", "startedAt": datetime.now(timezone.utc).isoformat(), "model": os.getenv("AIQA_TEXT_MODEL"), "scope": "5 synthetic rule samples + 1 case generation; not an accuracy benchmark", "promptVersion": "agents-v2", "promptSourceSha256": hashlib.sha256((REPO / "services/intelligence/src/aiqa_intelligence/agents/prompts.py").read_bytes()).hexdigest(), "evaluations": []}
    vectors = []
    def save():
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        args.output.with_suffix('.vectors.json').write_text(json.dumps(vectors, ensure_ascii=False, indent=2) + '\n')
    async def run(name, kind, wire, reader):
        records = []
        context = RequestContext(name, "real", reader, Gateway("real", reader, "agents-v2", records), records)
        entry = {"name": name, "kind": kind, "passed": False}
        try:
            agents = AgentPipelines()
            typed = (RuleExtractionInput if kind == 'rules' else CaseGenerationInput).model_validate(wire)
            method = agents.extract_rules if kind == 'rules' else agents.generate_cases
            result = await asyncio.wait_for(method(typed, context), 125)
            output = result.model_dump(mode='json', exclude_unset=True)
            vectors.append({"name": name, "kind": kind, "input": wire, "output": output, "valid": True})
            if kind == 'rules':
                check_rules(name, output)
            else:
                assert output['caseDrafts'], '真实生成未产出任何可核对的用例'
            entry['passed'] = True
            entry['draftCount'] = len(output['ruleDrafts' if kind == 'rules' else 'caseDrafts'])
            return output
        except (ServiceError, AssertionError, TimeoutError) as exc:
            entry['error'] = {"code": getattr(exc, 'code', type(exc).__name__), "message": str(exc)}
            cause = exc.__cause__
            if hasattr(cause, 'absolute_path'):
                entry['error']['schemaPath'] = list(cause.absolute_path)
                entry['error']['invalidValue'] = cause.instance
            return None
        finally:
            if not entry['passed'] and records:
                entry['failedOutput'] = records[-1].response.parsedJson
            entry['invocations'] = [{"provider": r.response.provider, "model": r.response.model, "requestId": r.response.requestId, "usage": r.response.usage.model_dump(), "latencyMs": r.response.latencyMs} for r in records]
            report['evaluations'].append(entry)
            save()
            print(json.dumps(entry, ensure_ascii=False), flush=True)
    with TemporaryDirectory(prefix='aiqa-kimi-agents-') as root:
        reader = ArtifactReader(Path(root))
        first = None
        if args.case_from:
            prior = json.loads(args.case_from.read_text())
            candidate = next(v for v in prior if v['name'] == NAMES[0] and v['kind'] == 'rules')
            from aiqa_intelligence.contracts.validation import validate_rules
            validate_rules(candidate['input'], candidate['output'])
            check_rules(NAMES[0], candidate['output'])
            first = candidate['output']
        for name in args.samples:
            bundle = json.loads((FIXTURES/name/'parsed-bundle.json').read_text())
            wire = {'documentVersions': [bundle], 'projectGlossary': [], 'images': [], 'promptVersion': 'agents-v2'}
            output = await run(name, 'rules', wire, reader)
            if name == NAMES[0]: first = output
            if output is None: break  # fail fast; do not spend on follow-on calls after a failed sample
        if first and all(e['passed'] for e in report['evaluations']):
            # Evaluation-only approval of one explicit threshold rule; never persists user assets.
            draft = next(d for d in first['ruleDrafts'] if d['classification']=='EXPLICIT' and any(f.get('value')==500000 for f in d.get('businessFields',[])))
            rule = copy.deepcopy(draft); rule.pop('key'); rule.update({'id':'eval-rule-v1','ruleId':'eval-rule-1','version':1,'reviewStatus':'APPROVED','origin':'model','createdAt':datetime.now(timezone.utc).isoformat(),'conflictsWith':[]})
            roles = list(dict.fromkeys([rule.get('role') or '申请人', '申请人', '部门主管']))
            await run('case-real-threshold','cases',{'approvedRuleVersions':[rule],'clarificationSources':[],'roles':roles,'fixtureCapabilities':[],'executorCapabilities':['navigate','click','fill','assert','switchRole','capture','waitFor'],'promptVersion':'agents-v2'},reader)
    report['passed'] = len(report['evaluations'])==len(args.samples)+(1 if NAMES[0] in args.samples or args.case_from else 0) and all(e['passed'] for e in report['evaluations'])
    report['completedAt'] = datetime.now(timezone.utc).isoformat()
    save()
    return report['passed']


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--env-file', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--samples', nargs='*', choices=NAMES, default=NAMES)
    parser.add_argument('--case-from', type=Path, help='Reuse an already recorded real threshold extraction for the case evaluation')
    args = parser.parse_args()
    if args.env_file: load_env(args.env_file)
    raise SystemExit(0 if asyncio.run(verify(args)) else 1)
