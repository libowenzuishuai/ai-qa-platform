"""C3 重复运行评测夹具：纯函数，无队列、无数据库、无额外 SDK。

用途（分工计划 §5 C3）：相同健康版本、固定标准下对关键旅程重复运行
（建议每条 ≥3 次），**保留首次失败与全部尝试**（不得用重试成功覆盖），
聚合通过率、语义错误、阻塞原因、耗时、用量与人工介入。

口径：
- 语义错误 = MODEL_OUTPUT_INVALID（结构/语义校验拒绝，模型输出问题）；
- 阻塞 = DEPENDENCY_UNAVAILABLE / NEEDS_OCR / MODEL_NOT_CONFIGURED /
  MODEL_TIMEOUT（环境与前置不满足，不是模型质量问题）；
- 用量取每次调用记录的 usage 汇总；人工介入由调用方显式标注，不自动推断。
mock 模式验证协议与统计口径；真实评测换 real 网关，报告结构不变。
"""

import asyncio
import time
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

from ..context import RequestContext
from ..errors import ServiceError

SEMANTIC_ERROR_CODES = {"MODEL_OUTPUT_INVALID"}
BLOCKED_CODES = {
    "DEPENDENCY_UNAVAILABLE",
    "NEEDS_OCR",
    "MODEL_NOT_CONFIGURED",
    "MODEL_TIMEOUT",
}


async def pipeline_attempt(fn: Callable[..., Awaitable[Any]], context: RequestContext, *args) -> dict:
    """跑一次管线并按评测口径记录（成功/错误码/耗时/用量）。

    旅程工厂用它包装三条管线之一；用量从 context.invocations 提取，
    失败时已发生的调用用量同样保留（语义错误也烧了 token）。
    """
    invocation_start = len(context.invocations)
    start = time.monotonic()
    ok, code, message = True, None, None
    try:
        await fn(*args)
    except ServiceError as error:
        ok, code, message = False, error.code, error.message
    return {
        "ok": ok,
        "errorCode": code,
        "errorMessage": message,
        "durationMs": int((time.monotonic() - start) * 1000),
        "usage": [
            {
                "provider": record.response.provider,
                "inputTokens": record.response.usage.inputTokens,
                "outputTokens": record.response.usage.outputTokens,
            }
            for record in context.invocations[invocation_start:]
        ],
    }


async def evaluate_repeatability(
    journeys: dict[str, Callable[[], Awaitable[dict]]],
    rounds: int = 3,
) -> dict:
    """每条旅程跑 rounds 次，保留全部尝试并聚合报告（JSON 可直出）。

    journeys：旅程名 → 异步工厂，每次调用返回 pipeline_attempt 形状的 dict，
    可附 "manualIntervention" 字段显式标注人工介入。
    """
    if type(rounds) is not int or not 1 <= rounds <= 100:
        raise ValueError("rounds must be an integer between 1 and 100")
    report_journeys = []
    for name, factory in journeys.items():
        attempts = []
        for index in range(rounds):
            attempt = await factory()
            attempts.append(
                {
                    "journey": name,
                    "attempt": index + 1,
                    "manualIntervention": attempt.get("manualIntervention"),
                    **{k: attempt.get(k) for k in ("ok", "errorCode", "errorMessage", "durationMs", "usage")},
                }
            )
        passed = sum(1 for a in attempts if a["ok"])
        codes = [a["errorCode"] for a in attempts if a["errorCode"]]
        report_journeys.append(
            {
                "journey": name,
                "attempts": attempts,  # 全部保留，含首次失败，不覆盖
                "passRate": passed / rounds,
                "semanticErrors": sum(1 for c in codes if c in SEMANTIC_ERROR_CODES),
                "blockedReasons": sorted({c for c in codes if c in BLOCKED_CODES}),
                "totalUsage": {
                    "inputTokens": sum(
                        u["inputTokens"] for a in attempts for u in a["usage"]
                    ),
                    "outputTokens": sum(
                        u["outputTokens"] for a in attempts for u in a["usage"]
                    ),
                },
                "manualInterventions": sum(1 for a in attempts if a.get("manualIntervention")),
                "firstFailureKept": True,  # 本夹具从不丢弃失败尝试
            }
        )
    return {
        "rounds": rounds,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "journeys": report_journeys,
    }
