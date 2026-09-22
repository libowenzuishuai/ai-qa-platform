"""Deterministic document chunking (chunk-v1).

服务端固定文档、策略、输入哈希后按标题/段落/表格与模型预算拆块。
同一输入（bundle + checksum + strategyParams）总是产生同一 manifest，
模型不参与分块决策。偏移按 Unicode code point 计（Python str 即码点），
与 TS 端共享同一契约与测试向量。

关键不变式：
- 不切掉尾部正文：每个 block 必须完整归属某个块（长块用显式切片）；
- 上下文重叠与正文分别记录（contextOverlap 不计入正文预算）；
- UNPARSED 块照样入块（引用保持），覆盖对账时归为 blocked；
- 跨块表格延续标记 isTableContinuation，表头不能仅由相邻尾部保证；消费端按来源 locator 单独补充或降级。
"""
from __future__ import annotations

import hashlib
from datetime import datetime, timezone

CHUNK_STRATEGY_VERSION = "chunk-v1"

# 输出预留：请求预算里除正文外还要容纳 system、schema 与输出，先保守预留。
OUTPUT_RESERVE_CHARS = 20_000


class ChunkLimit(ValueError):
    """分块参数不合法或预算矛盾。"""


def _validate_params(params: dict) -> dict:
    max_chars = params.get("maxCharsPerChunk")
    overlap = params.get("contextOverlapChars", 0)
    budget = params.get("modelBudgetChars")
    if not isinstance(max_chars, int) or max_chars < 500:
        raise ChunkLimit("maxCharsPerChunk 必须 ≥ 500")
    if not isinstance(overlap, int) or overlap < 0 or overlap > 5000:
        raise ChunkLimit("contextOverlapChars 必须在 [0, 5000]")
    if not isinstance(budget, int) or budget < 1000:
        raise ChunkLimit("modelBudgetChars 必须 ≥ 1000")
    if max_chars + overlap > budget - OUTPUT_RESERVE_CHARS:
        raise ChunkLimit(
            f"maxCharsPerChunk({max_chars}) 超过请求预算扣除输出预留后的剩余"
            f"（modelBudgetChars={budget} - 预留{OUTPUT_RESERVE_CHARS}）；"
            "字符是估算不是精确 token，必须保留硬上限"
        )
    if overlap >= max_chars:
        raise ChunkLimit("contextOverlapChars 必须小于 maxCharsPerChunk")
    return {"maxCharsPerChunk": max_chars, "contextOverlapChars": overlap, "modelBudgetChars": budget}


def _slice_span(span_id: str, text: str, max_chars: int) -> list[dict]:
    """超长块按 max_chars 切片，返回显式 SpanSlice 引用（码点偏移）。"""
    slices: list[dict] = []
    start = 0
    index = 0
    while start < len(text):
        end = min(start + max_chars, len(text))
        slices.append(
            {
                "type": "slice",
                "slice": {
                    "sourceSpanId": span_id,
                    "startOffset": start,
                    "endOffset": end,
                    "sliceId": f"{span_id}:slice:{index}",
                },
            }
        )
        start = end
        index += 1
    return slices


def chunk_bundle(
    bundle: dict,
    document_checksum: str,
    strategy_params: dict,
    *,
    created_at: str | None = None,
) -> dict:
    """把解析 bundle 拆成 ChunkManifest（确定性）。"""
    params = _validate_params(strategy_params)
    max_chars = params["maxCharsPerChunk"]
    overlap = params["contextOverlapChars"]

    blocks = bundle.get("blocks") or []
    spans = bundle.get("spans") or []
    if len(blocks) != len(spans):
        raise ChunkLimit("blocks 与 spans 数量不一致，输入损坏")
    if len(blocks)>10000 or sum(len(b.get("text") or "") for b in blocks)>2_000_000:
        raise ChunkLimit("分块输入超过 10000 块 / 200 万码点上限")
    document_id = bundle["documentVersionId"]
    prefix = hashlib.sha256(document_id.encode()).hexdigest()[:24]

    chunks: list[dict] = []
    total_code_points = 0
    # 上一个已产出块的最后一个 block kind（用于跨块表格延续判定）。
    last_emitted_kind: str | None = None

    def emit(boundary: str, texts: list[str], refs: list[dict], first_kind: str | None, last_kind: str | None):
        nonlocal total_code_points, last_emitted_kind
        body = "\n".join(t for t in texts if t != "")
        context = ""
        if overlap > 0 and chunks:
            prev = chunks[-1]["text"]
            context = prev[-overlap:] if len(prev) > overlap else prev
        # 跨块表格延续：本块以表格开始，且上一块以表格结束（不据此断言表头完整，消费端独立核实）。
        table_cont = first_kind == "table" and last_emitted_kind == "table"
        chunks.append(
            {
                "chunkId": f"c-{prefix}-{len(chunks)}",
                "seq": len(chunks),
                "boundary": boundary,
                "text": body,
                "contextOverlap": context,
                "spanRefs": refs,
                "isTableContinuation": table_cont,
                "estimatedChars": len(body),
            }
        )
        total_code_points += len(body)
        last_emitted_kind = last_kind

    current_texts: list[str] = []
    current_refs: list[dict] = []
    # boundary 描述“块由什么开始”，在首元素入块时记录，而不是 flush 时。
    current_boundary = "paragraph"
    current_first_kind: str | None = None
    current_last_kind: str | None = None

    def flush():
        nonlocal current_texts, current_refs, current_boundary
        nonlocal current_first_kind, current_last_kind
        if current_texts or current_refs:
            emit(current_boundary, current_texts, current_refs, current_first_kind, current_last_kind)
        current_texts, current_refs = [], []
        current_boundary, current_first_kind, current_last_kind = "paragraph", None, None

    def note_kind(kind: str):
        nonlocal current_first_kind, current_last_kind, current_boundary
        if current_first_kind is None:
            current_first_kind = kind
            current_boundary = "heading" if kind == "heading" else ("table" if kind == "table" else "paragraph")
        current_last_kind = kind

    for block, span in zip(blocks, spans):
        text = block.get("text") or ""
        span_id = span["id"]
        kind = block.get("kind", "paragraph")

        # 标题强制开新块（除非当前块为空）。
        if kind == "heading" and (current_texts or current_refs):
            flush()

        # 空文本（UNPARSED 表格单元格等）保留引用，不产生正文。
        if text == "":
            if current_first_kind is None:
                note_kind(kind)
            else:
                current_last_kind = kind
            current_refs.append({"type": "span", "spanId": span_id})
            continue

        # 超长块：显式切片，各切片独立成块，绝不截断尾部。
        if len(text) > max_chars:
            flush()
            for ref in _slice_span(span_id, text, max_chars):
                s = ref["slice"]
                emit("fixed-size", [text[s["startOffset"]:s["endOffset"]]], [ref], kind, kind)
            continue

        # 块粒度合并：加得下就并入当前块。
        if current_texts and len("\n".join(t for t in current_texts if t)) + len(text) + 1 > max_chars:
            flush()
        note_kind(kind)
        current_texts.append(text)
        current_refs.append({"type": "span", "spanId": span_id})
    flush()

    if not chunks:
        raise ChunkLimit("文档没有可分块内容")

    return {
        "documentVersionId": document_id,
        "strategyVersion": CHUNK_STRATEGY_VERSION,
        "documentChecksum": document_checksum,
        "strategyParams": params,
        "chunks": chunks,
        "totalCodePoints": total_code_points,
        "createdAt": created_at
        or datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
    }


def coverage_report(manifest: dict, spans: list[dict] | None = None) -> dict:
    """覆盖对账：每个片段必须归属 processed/context/blocked 之一。

    规则（与 TS 契约 ChunkCoverageReport 一致）：
    - 整段引用（span）与切片引用（slice）各自是独立片段；
    - 同一片段出现在多个块 → blocked（重复分配，manifest 应被拒绝）；
    - 同一 span 的切片区间必须连续无缝、无重叠，空洞单独立为 blocked 片段；
    - UNPARSED 片段（bundle spans 提供 quality）归 blocked（列语义不可靠）；
    - 三类之和必须等于总数（契约 superRefine 同款校验）。
    """
    assignments: list[dict] = []
    processed = context_n = blocked = 0

    quality_by_span = {s["id"]: s.get("extractionQuality", "GOOD") for s in (spans or [])}

    # fragmentId → 引用它的块 seq 集合。
    frag_blocks: dict[str, set[int]] = {}
    chunk_id_by_seq = {c["seq"]: c["chunkId"] for c in manifest["chunks"]}
    slice_ranges: dict[str, list[tuple[int, int]]] = {}
    for chunk in manifest["chunks"]:
        for ref in chunk["spanRefs"]:
            if ref["type"] == "slice":
                s = ref["slice"]
                frag_blocks.setdefault(s["sliceId"], set()).add(chunk["seq"])
                slice_ranges.setdefault(s["sourceSpanId"], []).append((s["startOffset"], s["endOffset"]))
            else:
                frag_blocks.setdefault(ref["spanId"], set()).add(chunk["seq"])

    for fragment_id, seqs in frag_blocks.items():
        if len(seqs) > 1:
            assignments.append(
                {
                    "fragmentId": fragment_id,
                    "assignment": "blocked",
                    "chunkId": None,
                    "reason": f"片段被多个块引用：{sorted(seqs)}",
                }
            )
            blocked += 1
            continue
        seq = next(iter(seqs))
        is_slice = ":slice:" in fragment_id  # spanId 本身不含冒号
        unparsed = not is_slice and quality_by_span.get(fragment_id) == "UNPARSED"
        if unparsed:
            assignments.append(
                {
                    "fragmentId": fragment_id,
                    "assignment": "blocked",
                    "chunkId": chunk_id_by_seq[seq],
                    "reason": "UNPARSED 片段，列语义不可靠",
                }
            )
            blocked += 1
        else:
            assignments.append({"fragmentId": fragment_id, "assignment": "processed", "chunkId": chunk_id_by_seq[seq]})
            processed += 1

    # 切片完整性：同一 span 的区间必须从 0 开始连续无缝；空洞单独立为 blocked。
    for span_id, ranges in sorted(slice_ranges.items()):
        cursor = 0
        for start, end in sorted(ranges):
            if start > cursor:
                assignments.append(
                    {
                        "fragmentId": f"{span_id}:gap:{cursor}-{start}",
                        "assignment": "blocked",
                        "chunkId": None,
                        "reason": "切片存在空洞，正文未被完整覆盖",
                    }
                )
                blocked += 1
            cursor = max(cursor, end)

    return {
        "documentVersionId": manifest["documentVersionId"],
        "chunkManifestChecksum": hashlib.sha256(
            "\n".join(c["text"] for c in manifest["chunks"]).encode()
        ).hexdigest(),
        "totalFragments": processed + context_n + blocked,
        "processedFragments": processed,
        "contextFragments": context_n,
        "blockedFragments": blocked,
        "assignments": assignments,
    }
