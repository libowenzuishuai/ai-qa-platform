# 试点交付与本地评测

此工具复用平台上传、版本冻结和运行 API，不绕过规则/用例审批。`example` 是合成资料，所有项目和资产 ID 都需替换；不计入真实试点数量。实际资料先脱敏，版本与 SHA-256 固定，批准记录标明人员、依据和允许范围。完整资料及第二项目仍待业务提供。

```sh
python3 tools/pilot-acceptance/pilot.py tools/pilot-acceptance/example/manifest.json --output /tmp/pilot-validation.json
```

默认只校验本地清单。包含六类维度的覆盖/阻塞/不适用理由、三种构建身份、相同的批准用例、文档校验和。`--action import --execute` 上传原始资料并解析（PDF/图片可能调用已配置模型）；新规则仍需在 UI 审阅批准。上传凭平台会话和项目权限；`AIQA_PLATFORM_URL` 与 `AIQA_PILOT_SESSION_COOKIE` 由操作者安全设置，勿填写在 manifest 或文档里。

资料审批、环境/账号准备、构建查询及基线固定后，`--action run --execute` 才创建健康/缺陷/修复三次运行。创建复用服务端幂等键，故障重试不新建同一运行；不要把生产网址放入测试环境。构建必须由真实版本查询接口核验，不能仅靠 manifest 声明。

从平台导出三份原始报告，命名 `healthy.json`、`defect.json`、`repaired.json`，使用 `--action evaluate --reports <目录>`。检查实际构建、原用例集合、预期失败用例、三态对照以及未覆盖维度；任何阻塞都不算正式通过。评测 ground truth 只在本地 evaluator 使用，不随资料传给 agent。输出文件独占创建，不覆盖首败或先前尝试；每次用不同的输出路径。脚本自动检查明确标为非人工复核。

## 模型真实评测

费用型评测保持 opt-in，参考 `services/intelligence/tests/doc_ingestion/fixtures/verify_b3_09_mixed_kimi_real.py` 及 `aiqa_intelligence.agents.evaluation`。真实输入先经平台作业/模型网关执行，保留每次调用的输入哈希、模型、提示词、参数、用量、原始输出与失败记录，再核对来源、数值单位、跨页/块关系、遗漏、权限和状态。mock、合成案例以及自动语义检查均不能冒充实际模型或业务人工复核。

本轮工具测试 7 项：路径/哈希、审批和维度、修复沿用原用例、未核验构建拒绝、合成不算真实通过、ground truth 不进入上传请求。未对用户 Dify 扩大写入范围。
