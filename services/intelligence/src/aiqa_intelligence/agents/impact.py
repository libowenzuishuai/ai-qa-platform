"""Deterministic review suggestions. Never updates approval or execution baselines."""

from dataclasses import dataclass, field

from ..contracts.generated import (
    ApprovedRuleVersion,
    TestCase,
    ImpactAnalysisInput,
    ImpactAnalysisOutput,
)
from ..contracts.validation import validate_shape, validate_source_report

KINDS = {"added", "removed", "modified", "uncertain"}


@dataclass
class SourceChange:
    kind: str
    old: tuple[str, str] | None = None
    new: tuple[str, str] | None = None
    quality: str | None = None
    note: str | None = None

    def __post_init__(self):
        if self.kind not in KINDS:
            raise ValueError(f"未知变化类型：{self.kind}")
        if self.kind == "added" and (self.old is not None or self.new is None):
            raise ValueError("added 必须只有新侧引用")
        if self.kind == "removed" and (self.old is None or self.new is not None):
            raise ValueError("removed 必须只有旧侧引用")
        if self.kind == "modified" and (self.old is None or self.new is None):
            raise ValueError("modified 必须携带新旧引用")
        if self.kind == "uncertain" and (
            self.old is None or not self.note or not self.note.strip()
        ):
            raise ValueError("uncertain 必须携带旧侧引用与原因")
        if self.quality not in {None, "GOOD", "LOW", "UNPARSED"}:
            raise ValueError("未知来源质量")

    def refs(self):
        return [r for r in (self.old, self.new) if r is not None]


def adapt_source_changes(raw: list[dict]) -> list[SourceChange]:
    changes = []
    for item in raw:
        validate_shape("SourceChange", item)
        old, new = item["old"], item["new"]
        qualities = [s.get("extractionQuality", "GOOD") for s in (old, new) if s]
        changes.append(
            SourceChange(
                kind=item["kind"],
                old=(old["documentVersionId"], old["id"]) if old else None,
                new=(new["documentVersionId"], new["id"]) if new else None,
                quality=max(qualities, key={"GOOD": 0, "LOW": 1, "UNPARSED": 2}.get),
                note=item["reason"],
            )
        )
    return changes


@dataclass
class ImpactReport:
    affected_rules: list[dict] = field(default_factory=list)
    affected_cases: list[dict] = field(default_factory=list)
    unresolved: list[str] = field(default_factory=list)
    requires_human_review: bool = True

    def to_wire(self):
        return ImpactAnalysisOutput.model_validate(
            dict(
                affectedRules=self.affected_rules,
                affectedCases=self.affected_cases,
                unresolved=self.unresolved,
                requiresHumanReview=self.requires_human_review,
            )
        ).model_dump(mode="json")


def analyze_impact(
    changes: list[SourceChange],
    approved_rule_versions: list[ApprovedRuleVersion],
    approved_case_versions: list[TestCase],
) -> ImpactReport:
    if any(r.reviewStatus != "APPROVED" for r in approved_rule_versions) or any(
        c.approvalStatus != "APPROVED" for c in approved_case_versions
    ):
        raise ValueError("影响分析只接受已批准资产")
    for assets in (approved_rule_versions, approved_case_versions):
        if len({a.id for a in assets}) != len(assets):
            raise ValueError("输入资产版本重复")
    report = ImpactReport()
    affected_ids = set()
    for rule in sorted(approved_rule_versions, key=lambda r: r.id):
        refs = {
            (s.documentVersionId, str(sid.root))
            for s in rule.sources
            for sid in s.sourceSpanIds
        }
        # Only old evidence affects an existing rule; additions propose extraction.
        # Keep ALL hits. A dictionary keyed by span would silently overwrite one.
        hits = [c for c in changes if c.old and c.old in refs]
        if not hits:
            continue
        reasons = set()
        for c in hits:
            if c.quality in {"LOW", "UNPARSED"}:
                reasons.add("SOURCE_QUALITY_UNCERTAIN")
            else:
                reasons.add(
                    {
                        "removed": "SOURCE_REMOVED",
                        "modified": "SOURCE_MODIFIED",
                        "uncertain": "SOURCE_UNCERTAIN",
                    }[c.kind]
                )
        if "SOURCE_QUALITY_UNCERTAIN" in reasons:
            report.unresolved.append(
                f"规则 {rule.id} 的来源质量为 LOW/UNPARSED，仅作待复核标记，不能确定业务规则已改变"
            )
        report.affected_rules.append(
            dict(
                ruleVersionId=rule.id,
                reason="+".join(sorted(reasons)),
                evidenceRefs=[
                    dict(documentVersionId=d, spanId=s)
                    for d, s in sorted({ref for c in hits for ref in c.refs()})
                ],
                suggestion="复核该规则的出处是否仍然成立；确认后由平台生成新版本",
            )
        )
        affected_ids.add(rule.id)
    for case in sorted(approved_case_versions, key=lambda c: c.id):
        via = sorted({str(r.root) for r in case.ruleVersionIds} & affected_ids)
        if via:
            report.affected_cases.append(
                dict(
                    caseVersionId=case.id,
                    viaRuleVersionIds=via,
                    reason="RULE_SOURCE_CHANGED",
                    suggestion="来源规则需复核，确认后再决定是否生成新用例版本",
                )
            )
    for change in changes:
        if change.kind == "added":
            report.unresolved.append("新增片段可能产生新规则，需重新执行规则提取")
        if change.kind == "uncertain":
            report.unresolved.append(
                "存在无法唯一对应的片段变化，相关结论按待复核处理，不得视为未变化："
                + change.note
            )
        if change.quality in {"LOW", "UNPARSED"}:
            report.unresolved.append("来源质量 LOW/UNPARSED，需核对原资料后再确认影响")
    report.unresolved = sorted(set(report.unresolved))
    return report


def analyze_report(input: dict) -> dict:
    """Shared-contract entry point; platform must load project-scoped, trusted assets."""
    validate_shape("ImpactAnalysisInput", input)
    typed = ImpactAnalysisInput.model_validate(input)
    for report in input["sourceReports"]:
        validate_source_report(report)
    for case in typed.approvedCaseVersions:
        if not case.approvalHash:
            raise ValueError("批准用例必须携带 approvalHash")
    changes = adapt_source_changes(
        [c for r in input["sourceReports"] for c in r["changes"]]
    )
    return analyze_impact(
        changes, typed.approvedRuleVersions, typed.approvedCaseVersions
    ).to_wire()
