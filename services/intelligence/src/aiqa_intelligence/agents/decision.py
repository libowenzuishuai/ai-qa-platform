"""W08（INT-06）决策端：确定性关键词基线（第一基线，不依赖模型）。

Jev/普通模型结构化决策是后续基线；未配置时本端点完整可用。
低置信/无命中/平局 → fallbackUsed=true（不猜）。
"""
from __future__ import annotations

import re


def _tokens(text: str) -> set[str]:
    result: set[str] = set()
    for word in re.split(r"[^\w]+", text.lower()):
        if not word:
            continue
        if word.isascii():
            result.add(word)
            continue
        for i in range(len(word) - 1):
            result.add(word[i : i + 2])
        if len(word) == 1:
            result.add(word)
    return result


def decide(data: dict) -> dict:
    question = _tokens(data.get("question", ""))
    options = data.get("options") or []
    if len(options) < 2:
        raise ValueError("决策需要至少两个选项")
    best = None
    tie = False
    for option in options:
        overlap = len(question & _tokens(f"{option.get('label', '')} {option.get('context', '')}"))
        if best is None or overlap > best["score"]:
            best, tie = {"id": option["id"], "score": overlap}, False
        elif overlap == best["score"]:
            tie = True
    kind = data.get("kind", "choose")
    if not best or best["score"] == 0 or (tie and kind == "choose"):
        return {
            "kind": kind, "selectedOptionId": None,
            "score": 0.0 if kind == "score" else None, "category": None,
            "rawConfidence": None, "fallbackUsed": True,
            "fallbackReason": "无关键词命中" if (not best or best["score"] == 0) else "平局无法唯一选择",
        }
    return {
        "kind": kind,
        "selectedOptionId": best["id"] if kind == "choose" else None,
        "score": min(1.0, best["score"] / max(1, len(question))) if kind == "score" else None,
        "category": None, "rawConfidence": None,
        "fallbackUsed": False, "fallbackReason": None,
    }
