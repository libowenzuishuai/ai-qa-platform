# 隔离复现夹具适配协议 v1

能力：`platform.reproduction-minimize@1.0.0`。它在 Harness 图中执行受限步骤删减，并保留首次失败与所有试验记录。默认不安装、不授权。

## 接入方必须实现的业务责任

夹具服务运行在专用测试环境，能够按命名空间隔离数据、重置业务状态、执行已登记步骤、运行固定断言和幂等清理。不能把 namespace 当注释却操作全库，也不能根据期望失败指纹直接返回 fail。

`buildId` 必须对应实际运行构建，`oracleHash` 必须对应真实冻结的断言。服务应拒绝未知构建、标准或步骤 ID。平台验证回执身份和证据非空，但无法代替服务证明隔离、断言或证据的业务真实性；适配器须独立验收后授权。

只使用以下固定 POST 路径，响应均为 JSON；重定向拒绝，响应上限 64 KiB：

| 路径 | 操作 |
|---|---|
| `/aiqa/reproduction/reset` | 创建或幂等恢复指定命名空间的干净初始状态 |
| `/aiqa/reproduction/trial` | 在该命名空间执行 steps，并用指定 Oracle 判定 |
| `/aiqa/reproduction/cleanup` | 幂等删除该命名空间拥有的测试资源；已清理仍确认成功 |

三个接口请求均为：

```json
{
  "namespace": "aiqa-<24位调用身份哈希>-<试验序号>",
  "buildId": "approved-build-id",
  "oracleHash": "64位小写十六进制哈希",
  "steps": ["open-draft", "save-draft"],
  "idempotencyKey": "<namespace>:trial"
}
```

reset/cleanup 的 steps 是空数组。trial 中的 ID 是预登记业务动作，不是代码、URL 或脚本。

所有响应必须回显 `namespace`、`buildId`、`oracleHash`。reset/cleanup 还须返回 `clean: true`。trial 返回：

```json
{
  "namespace": "<原始命名空间>",
  "buildId": "<实际构建>",
  "oracleHash": "<实际标准哈希>",
  "verdict": "fail",
  "failureKey": "draft-not-persisted",
  "evidence": ["<服务保留的该次试验真实证据引用>"]
}
```

不同缺陷的 fail 不能算原缺陷仍可复现。证据引用应可追溯到实际试验；不要放密码或长期公开凭据链接。

## 平台配置

1. 项目管理员在组合编辑页面启用该能力。授权范围为 `fixture:isolated-reproduction`。
2. 将服务 origin 登记到专用非生产测试环境白名单。
3. 把能力固定到 Profile，并在图节点中绑定 baseUrl/buildId/oracleHash/failureKey/steps/maxTrials。steps 是 JSON 数组，使用任务输入绑定；图常量当前只接受字符串、数字或布尔。
4. 新建会话。复现输入的 buildId/oracleHash 必须与会话冻结值完全相同。
5. 配置足够的工具/资源预算。每次 reset/trial/cleanup 都计调用；每个 reset 预留一个资源名额。预算或时间耗尽可能留下待清理资源，必须查看台账。

输出包括 candidate、trials、minimal、verified、recordJson。最大 100 个唯一步骤、2–30 次试验。只有完整原流程先复现同一失败，才开始删减。`minimal: true` 仅表示删任何一个剩余步骤都不能继续复现；不是全局最短序列。达到上限会保留已验证候选并返回 `minimal: false`。

## 故障与清理

调用前后分别记录意图与回执。状态不明禁止自动重做整个写节点；清理失败返回 UNKNOWN 和残留命名空间，不能返回 PASS。宿主撤权、租约丢失或预算停止后也不能绕过控制继续调用目标。

停止会话的资源台账提供管理员清理入口。清理 URL、构建、标准和幂等键都从原调用证据恢复；调用方只选择账本中现有资源。证据缺失标 unknown，原始输入被篡改拒绝清理。清理成功不会修改原运行 verdict。

## 已验收范围

`apps/worker/test/v2-reproduction.test.ts` 使用真实隔离 HTTP 服务验证删减、身份漂移、预算停止、清理失败。`v2-durable-graph.test.ts` 验证安装→授权→发布→执行→持久资源台账→拒绝无归属清理→管理员重清理的完整流程。

这些是合成夹具验收；接入真实业务时仍需验证命名空间隔离、原标准判定、重复请求及跨运行清理隔离。
