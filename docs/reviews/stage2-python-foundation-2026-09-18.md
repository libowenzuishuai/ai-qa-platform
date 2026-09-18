# Python 智能服务基建验收

日期：2026-09-18。基于 `c5d00a4`，按用户要求调整阶段二语言边界。

## 已交付

- 保留 TypeScript 页面、API、队列/作业状态、浏览器执行、证据与最终入库。
- 新增 `services/intelligence` Python 服务。B/C 目录、类型、异步方法签名与测试目录已建立，正式算法未代写。
- 新增内部协议 v1；已有 Zod 业务契约继续为唯一手写字段定义，自动生成 JSON Schema 与 Python/Pydantic 模型。提供重生成与漂移检查命令。
- Python 输入/输出校验，以及来源/冲突/覆盖等业务校验；两端共享 19 个合法和反例样例。JSON Schema 不冒充完整的业务校验。
- Python 模型网关支持明确 real/mock、文本/视觉、超时、结构校验、token 参数和调用记录。mock 未命中报错；real 缺配置报错；严格 JSON 解析，不修改业务正文。
- Python 只读 ArtifactReader 检查路径边界、大小和校验和；不获取数据库/队列权限。
- TS worker 增加显式 Python 模式、内部令牌、请求编号/模式校验、响应二次校验及模型调用记录落库。
- Dockerfile、可选 compose profile、环境示例、CI 契约检查，以及三人开工清单。

## 验证结果

| 检查 | 结果 | 说明 |
|---|---|---|
| TS 契约 | 131/131 | 包括 19 个跨语言公共样例 |
| Python | 29/29 | 包括相同 19 个公共样例、服务/超时/错误、路径与校验和、模型协议和调用记录 |
| worker | 17/17 | 包括真实 Python HTTP 往返；真实临时 PostgreSQL/独立 Redis 回归；Python 草稿和调用记录落库/伪造来源拒绝 |
| API | 48/48 | 权限、运行、作业和错误处理回归 |
| 原 TS 模型适配器 | 26/26 | 保留参考模式兼容性 |

合计 **251 项测试**。公共样例有意在两种语言各执行一次，不是 251 个独立业务场景。

全仓类型检查、worker 构建、JSON Schema/Python 生成物一致性检查、compose 配置静态校验通过。

HTTP 测试启动真实 Python 服务，但注入的是测试专用确定性 handler。Python worker 落库测试使用受控 HTTP 响应和真实数据库；未将其描述为正式算法端到端验收。模型协议测试使用 fake key 与 HTTP mock transport，没有付费 API 调用。

## 边界与后续

- 默认 reference 是迁移兼容模式；选择 Python 后失败不回退。B/C 完成前，正式服务入口返回 503 并在健康接口标记能力未就绪。
- B/C 新算法与 DOCUMENT_PARSE 上传/作业接线、澄清/审阅页面仍待开发，分工详见 [开工清单](../stage2-python-handoff.md)。
- 旧文档解析分支 `f07f928` 未合并，B 在新 Python 目录继续实现并迁移验收用例。
- 本轮没有真实 Kimi 验证、容器镜像运行验收、生产负载或全平台浏览器 harness 重跑。Python/生成工具有依赖弃用提示，当前锁定版本测试通过。
- GitHub CI 配置已提供；本地通过不代表远端 CI 已运行。
