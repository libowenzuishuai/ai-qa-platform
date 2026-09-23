"""W01 跨语言向量（shape 层）：与 TS Zod 对同一 JSON 向量必须同判。

语义 refine（闭包/预算关系/证据规则等）是 TS 服务端权威层，不在 Python 镜像
（避免两套判定规则）；Python 只验证形状/类型/枚举/模式一致性。
"""
import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from aiqa_intelligence.contracts import generated as m

ROOT = Path(__file__).resolve().parents[2]
VECTORS = json.loads(
    (ROOT.parent / "packages/contracts/fixtures/v2-w01-vectors.json").read_text()
)

SHAPE_CASES = [c for c in VECTORS["cases"] if c["layer"] == "shape"]


def _model_for(schema_name: str):
    model = getattr(m, schema_name, None)
    if model is None:
        # 顶层导出名带 V2 前缀（见 export-intelligence.ts）；嵌套类型按字段注解取。
        raise AssertionError(f"生成模型缺少 {schema_name}")
    return model


@pytest.mark.parametrize("case", SHAPE_CASES, ids=[c["name"] for c in SHAPE_CASES])
def test_shape_vectors_match_ts_verdict(case):
    model = _model_for(case["schema"])
    if case["valid"]:
        model.model_validate(case["value"])
    else:
        with pytest.raises(ValidationError):
            model.model_validate(case["value"])


def test_fixture_has_both_layers():
    assert any(c["layer"] == "semantic" for c in VECTORS["cases"])
    assert len(SHAPE_CASES) >= 15
