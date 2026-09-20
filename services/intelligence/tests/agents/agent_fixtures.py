"""C 通道测试公共件：mock 网关上下文、ready 实例、conformance 向量。

不使用 conftest.py——根目录 tests/test_contracts.py 以 `from conftest import
VECTORS` 引用根 conftest，本目录再放一个 conftest 会遮蔽模块名。
mock 网关不触网络、不碰数据库；ready 实例只存在于测试进程
（类默认 False 是对 HTTP 层的诚实 503，见 agents/service.py）。
"""

import json
from pathlib import Path

from aiqa_intelligence.agents.service import AgentPipelines
from aiqa_intelligence.context import RequestContext
from aiqa_intelligence.models import Gateway
from aiqa_intelligence.storage import ArtifactReader

VECTORS = json.loads(
    (
        Path(__file__).resolve().parents[4]
        / "packages"
        / "contracts"
        / "fixtures"
        / "intelligence-conformance.json"
    ).read_text()
)


def vector(name: str) -> dict:
    """按名取两端共用契约样例；正反例以 valid 字段区分，不写死数量。"""
    return next(v for v in VECTORS if v["name"] == name)


def make_agent_context(tmp_path: Path) -> tuple[RequestContext, Gateway]:
    records = []
    gateway = Gateway(
        mode="mock",
        artifacts=ArtifactReader(tmp_path),
        prompt_version="handoff-1",
        records=records,
        mock_entries={},
    )
    context = RequestContext(
        request_id="req-agents-test",
        mode="mock",
        artifacts=gateway.artifacts,
        models=gateway,
        invocations=records,
    )
    return context, gateway


def ready_agent_pipelines() -> AgentPipelines:
    pipelines = AgentPipelines()
    pipelines.ready = True
    return pipelines
