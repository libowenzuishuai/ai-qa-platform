# packages/evaluation（占位）

结果聚合、覆盖统计与缺陷指纹（PRD FR-10、§5.2 聚合规则）：
- 有必需断言 FAIL → case FAIL；
- 无 FAIL 但关键步骤受阻 → BLOCKED；
- 证据不足 → REVIEW；
- 从未开始 → NOT_RUN；
- 空断言集合禁止 PASS。

黄金验收（评测器 ground truth）当前位于 apps/demo-app/tests-golden。
本目录阶段 1 实现聚合器。
