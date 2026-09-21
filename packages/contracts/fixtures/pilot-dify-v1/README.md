# Dify 脱敏试点输入 v1

这是可随 Git 取得的**真实观察记录**，不是官方 PRD、完整客户资料或自动化执行证据。来源见 manifest；测试账号、工作区名称、草稿 ID 和会话均未打包。

- B：以本目录为 ArtifactReader 根目录，使用 manifest.storage 中的 storageKey、SHA-256、大小与 documentVersionId 运行文档解析；可补 b3-08 的观察记录子项，不能因此宣布完整真实客户资料验收通过。
- C：bundle.json 可直接输入规则提取；规则仍需人工批准。正常、空名称边界、草稿状态与刷新持久性有设计依据；权限、多角色必须列 BLOCKED。根据 manifest 逐项对账，不为凑齐六类编造需求。
- 模型反馈已在 docs/delivery/evidence/real-plan-trial-v1.json、real-plan-trial-v2.json、real-plan-evaluation.json；分别保留旧版本失败与 planner-v3 的合成项目通过结果。它们不是 Dify 的通过记录。

本目录就是可移植 storage，无需等待 A 的本机目录或账号。新机器克隆仓库后可用；不要把真实登录态放入 Git。
