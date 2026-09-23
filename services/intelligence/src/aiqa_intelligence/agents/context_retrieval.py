"""CTX-04 检索基线：关键词/结构/来源关联打分（确定性，无外部依赖）。

Alpha 基线策略 keyword-structural-v1：
- 关键词：查询词在片段原文中的命中（中文按字符 bigram，避免分词依赖）；
- 结构：标题/表格片段加权（信息密度高于普通段落）；
- 来源关联：批准规则的 sources 引用的片段直接入选（权威路径）。
输出 selected/rejected + 分数 + 原因；无命中时如实返回（调用方记录 blocked，
不把"检索无命中"当作"没有要求"）。
"""
from __future__ import annotations

import re

STRATEGY_VERSION = "keyword-structural-v1"


def _bigrams(text: str) -> set[str]:
    cleaned = re.sub(r"\s+", "", text)
    return {cleaned[i : i + 2] for i in range(max(0, len(cleaned) - 1))}


def _keyword_score(query: str, text: str | None) -> float:
    if not text:
        return 0.0
    q = _bigrams(query)
    t = _bigrams(text)
    if not q:
        return 0.0
    return len(q & t) / len(q)


def _structure_weight(block_kind: str | None, quality: str) -> float:
    if quality == "UNPARSED":
        return 0.0  # 未解析内容不进入规划（另行 blocked）
    base = 1.0
    if block_kind == "heading":
        base = 1.25
    elif block_kind == "table":
        base = 1.15
    elif quality == "LOW":
        base = 0.7
    return base


def retrieve(data: dict) -> dict:
    """输入（ContextRetrievalInput 形状）→ selections 列表。

    输入：query、documentVersions（bundle 列表）、ruleRefs（批准规则
    [{ruleVersionId, sourceSpanIds}]）、maxSelected。
    输出：{strategy, selections: [{kind, ref, documentVersionId, score,
    decision, reason}]}——冲突/未解析单独标 kind 供调用方入账。
    """
    query = data.get("query", "")
    rule_refs = data.get("ruleRefs") or []
    max_selected = int(data.get("maxSelected", 50))

    # 来源关联：规则引用的 span 直接入选（权威）。
    authoritative: dict[str, set[str]] = {}
    for rule in rule_refs:
        for span_id in rule.get("sourceSpanIds", []):
            authoritative.setdefault(span_id, set()).add(rule["ruleVersionId"])

    scored: list[dict] = []
    for bundle in data.get("documentVersions", []):
        version_id = bundle["documentVersionId"]
        kinds = {b["id"]: b.get("kind", "paragraph") for b in bundle.get("blocks", [])}
        for index, span in enumerate(bundle.get("spans", [])):
            ref = span["id"]
            quality = span.get("extractionQuality", "GOOD")
            text = span.get("quotedText")
            if quality == "UNPARSED":
                scored.append({
                    "kind": "unparsed_range", "ref": ref, "documentVersionId": version_id,
                    "score": None, "decision": "rejected",
                    "reason": "未解析片段：不能作为规划依据，转人工/后续处理",
                })
                continue
            block_kind = None
            if index < len(bundle.get("blocks", [])):
                block_kind = bundle["blocks"][index].get("kind")
            kw = _keyword_score(query, text)
            weight = _structure_weight(block_kind, quality)
            if ref in authoritative:
                score = min(1.0, 0.8 + 0.2 * kw)
                reason = "批准规则来源关联（权威）" + ("；关键词命中" if kw > 0 else "")
            else:
                score = kw * weight
                reason = f"关键词 {kw:.2f} × 结构权重 {weight:.2f}"
            if score <= 0:
                scored.append({
                    "kind": "span", "ref": ref, "documentVersionId": version_id,
                    "score": round(score, 4), "decision": "rejected",
                    "reason": "与查询无关键词关联",
                })
            else:
                scored.append({
                    "kind": "span", "ref": ref, "documentVersionId": version_id,
                    "score": round(score, 4), "decision": "selected", "reason": reason,
                })

    # 预算：按分数降序保留 maxSelected；被挤出的转为 rejected（截断对账）。
    selected = [s for s in scored if s["decision"] == "selected"]
    rejected = [s for s in scored if s["decision"] == "rejected"]
    selected.sort(key=lambda s: (-float(s["score"] or 0), s["ref"]))
    overflow = selected[max_selected:]
    kept = selected[:max_selected]
    for item in overflow:
        item["decision"] = "rejected"
        item["reason"] = f"预算截断（排名超出 maxSelected={max_selected}）"
    return {"strategy": STRATEGY_VERSION, "selections": kept + overflow + rejected}
