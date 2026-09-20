"""C3 需求变更影响分析：纯函数骨架，无队列、无数据库、无模型调用。

依据提案 docs/delivery/proposals/c3-impact-analysis.md：
- 受影响判定是确定性的：规则 sources 与变更片段的**交集闭包**，
  交集为空的资产不得出现在建议里（不许顺带扩大复核面）；
- 用例只经规则传导（ruleVersionIds），不直接关联片段；
- 本模块只建议不批准：requiresHumanReview 恒为 True，
  旧任务继续使用旧版本，不自动改写基线；
- B2 差异形状未定稿：SourceChange 是最小形状适配层，
  B 落地后只改 adapt_source_changes，判定算法不动。

LLM 增强（更自然的建议文案）属后续版本；当前建议文本为确定性模板，
保证同一输入同一输出，可进重复运行评测（agents/evaluation.py）。
"""

from dataclasses import dataclass, field

from ..contracts.generated import ApprovedRuleVersion, TestCase

KINDS = {"added", "removed", "modified", "ambiguous"}
REASON_BY_KIND = {
    "removed": "SOURCE_REMOVED",
    "modified": "SOURCE_MODIFIED",
    "ambiguous": "SOURCE_AMBIGUOUS",
}
# 质量不足的变化不给确定性结论，进待复核（提案待确认项 2 的倾向实现）
UNRESOLVED_QUALITIES = {"LOW", "UNPARSED"}


@dataclass
class SourceChange:
    """B2 差异的最小形状（提案 §2 的三点最小要求）。"""

    kind: str  # added / removed / modified / ambiguous
    old: tuple[str, str] | None = None  # (documentVersionId, spanId)
    new: tuple[str, str] | None = None
    quality: str | None = None  # 命中片段的 extractionQuality（可选）
    note: str | None = None  # ambiguous 时 B2 的「待确认」说明

    def __post_init__(self):
        if self.kind not in KINDS:
            raise ValueError(f"未知变化类型：{self.kind}")
        if self.kind == "added" and self.old is not None:
            raise ValueError("added 变化不应携带旧侧引用")
        if self.kind == "removed" and self.new is not None:
            raise ValueError("removed 变化不应携带新侧引用")
        if self.kind in {"modified", "ambiguous"} and (self.old is None or self.new is None):
            raise ValueError(f"{self.kind} 变化必须携带新旧两侧引用")

    def refs(self) -> list[tuple[str, str]]:
        return [ref for ref in (self.old, self.new) if ref is not None]


def adapt_source_changes(raw: list[dict]) -> list[SourceChange]:
    """B2 原始 JSON → 最小形状。B2 形状定稿后，全模块只需改这里。"""
    changes = []
    for item in raw:
        old = item.get("old")
        new = item.get("new")
        changes.append(
            SourceChange(
                kind=item["kind"],
                old=(old["documentVersionId"], old["spanId"]) if old else None,
                new=(new["documentVersionId"], new["spanId"]) if new else None,
                quality=item.get("quality"),
                note=item.get("note"),
            )
        )
    return changes


@dataclass
class ImpactReport:
    """输出（提案 §3 形状，agents 内部形状，未进共享契约）。"""

    affected_rules: list[dict] = field(default_factory=list)
    affected_cases: list[dict] = field(default_factory=list)
    unresolved: list[str] = field(default_factory=list)
    requires_human_review: bool = True

    def to_wire(self) -> dict:
        return {
            "affectedRules": self.affected_rules,
            "affectedCases": self.affected_cases,
            "unresolved": self.unresolved,
            "requiresHumanReview": self.requires_human_review,
        }


def _rule_span_refs(rule: ApprovedRuleVersion) -> set[tuple[str, str]]:
    return {
        (source.documentVersionId, str(span_id.root))
        for source in (rule.sources or [])
        for span_id in source.sourceSpanIds
    }


def analyze_impact(
    changes: list[SourceChange],
    approved_rule_versions: list[ApprovedRuleVersion],
    approved_case_versions: list[TestCase],
) -> ImpactReport:
    """确定性影响判定：来源交集闭包 + 规则传导到用例。"""
    report = ImpactReport()
    changed_refs: dict[tuple[str, str], SourceChange] = {}
    for change in changes:
        for ref in change.refs():
            changed_refs[ref] = change

    affected_rule_ids = set()
    for rule in approved_rule_versions:
        hits = [changed_refs[ref] for ref in _rule_span_refs(rule) if ref in changed_refs]
        if not hits:
            continue  # 无交集不得出现在建议里
        if any(c.quality in UNRESOLVED_QUALITIES for c in hits):
            report.unresolved.append(
                f"规则 {rule.id} 的来源片段变更质量为 LOW/UNPARSED，"
                "无法给出确定性影响结论，需人工复核"
            )
            affected_rule_ids.add(rule.id)
            continue
        kinds = sorted({c.kind for c in hits if c.kind != "added"})
        reasons = [REASON_BY_KIND[k] for k in kinds] or ["SOURCE_ADDED"]
        report.affected_rules.append(
            {
                "ruleVersionId": rule.id,
                "reason": "+".join(reasons),
                "evidenceRefs": [
                    {"documentVersionId": doc, "spanId": span}
                    for c in hits
                    for doc, span in c.refs()
                ],
                "suggestion": "复核该规则的出处是否仍然成立；确认后由平台生成新版本",
            }
        )
        affected_rule_ids.add(rule.id)

    for case in approved_case_versions:
        via = [rid for rid in (str(r.root) for r in case.ruleVersionIds) if rid in affected_rule_ids]
        if via:
            report.affected_cases.append(
                {
                    "caseVersionId": case.id,
                    "viaRuleVersionIds": via,
                    "reason": "RULE_SOURCE_CHANGED",
                    "suggestion": "来源规则已变更，复核该用例预期是否需要跟随新版本调整",
                }
            )

    for change in changes:
        if change.kind == "added":
            report.unresolved.append(
                "新增片段可能产生新规则，需对新增内容重新执行规则提取"
                + (f"（{change.note}）" if change.note else "")
            )
        if change.kind == "ambiguous":
            report.unresolved.append(
                "存在无法唯一对应的片段变化（移动/拆分/合并），"
                "相关结论按待复核处理，不得视为未变化"
                + (f"（{change.note}）" if change.note else "")
            )
    return report
