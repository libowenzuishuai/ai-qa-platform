# Python 智能服务

平台为 TypeScript；文档解析与 agents 为 Python。完整分工见 [开工清单](../../docs/stage2-python-handoff.md)。Python 只返回解析产物/草稿/调用记录，平台负责鉴权、队列、状态和数据库。

## 当前状态

已提供服务、协议、生成类型、业务校验、模型网关、只读文件访问、测试与 TS 客户端。B/C 的正式算法入口尚未实现，返回明确 503。`/health` 的 capabilities 如实为 false。

## 本地启动（从仓库根目录）

使用 Python 3.11+（本轮在 3.13 验证）和 Node 22+。

```sh
pnpm install --frozen-lockfile
python3 -m venv services/intelligence/.venv
services/intelligence/.venv/bin/python -m pip install -r services/intelligence/requirements-dev.lock
export AIQA_INTELLIGENCE_TOKEN='local-development-only-change-me'
export AIQA_ARTIFACT_DIR="$PWD/data/artifacts"
pnpm dev:intelligence
```

服务监听 `127.0.0.1:7500`。以上令牌只用于本机开发示例；共享/部署环境使用自己的令牌。服务不自动读取根 `.env`，凭据由进程环境注入，避免测试意外调用付费模型。

需要模型时设置现有 `AIQA_TEXT_*` / `AIQA_VISION_*` 环境变量。只有显式 real 调用会访问 Moonshot；mock 查表未命中直接失败。Python 网关目前严格 JSON 解析（修复次数为 0），不修改业务正文；网络协议用 mock transport 测试，尚未做真实 Kimi 验证。

## API 与 worker 切换

API 与 worker 同时设置 `AIQA_INTELLIGENCE_BACKEND=python`，worker 另需：

```sh
export AIQA_INTELLIGENCE_URL='http://127.0.0.1:7500'
export AIQA_INTELLIGENCE_TOKEN='与 Python 服务相同的令牌'
export AIQA_INTELLIGENCE_TIMEOUT_MS='120000'
```

默认 `reference` 是迁移兼容模式，继续使用已存在的 TS 参考管线；Python 出错不会回退。B/C 完成前切换 Python 会得到“模块待实现”的明确失败。

## 内部接口 v1

| 路径 | 请求 | 响应 |
|---|---|---|
| POST /v1/documents/parse | DocumentParseRequest | DocumentParseResponse |
| POST /v1/rules/extract | RuleExtractionRequest | RuleExtractionResponse |
| POST /v1/cases/generate | CaseGenerationRequest | CaseGenerationResponse |

均使用 `Authorization: Bearer <内部令牌>`。请求包含 schemaVersion=`1.0`、requestId、mode、timeoutMs、input；响应原样回传版本、请求 ID、mode，另有 output 与 invocations。文件通过只读共享目录的 storageKey、大小、SHA-256 引用，不传任意下载 URL。

NEEDS_OCR 是合法解析结果，HTTP 200 返回对应 bundle；下游规则提取拒绝它。错误体使用现有 code/message/requestId。健康接口不暴露凭据。

## 开发入口

- B：`src/aiqa_intelligence/doc_ingestion/service.py`，测试 `tests/doc_ingestion/`。
- C：`src/aiqa_intelligence/agents/service.py`，测试 `tests/agents/`。
- A：`app.py`、`context.py`、`models.py`、`storage.py`、`contracts/`、TS 平台接线。

类型导入示例：

```python
from aiqa_intelligence.contracts.generated import RuleExtractionInput, RuleExtractionOutput, TextModelRequest
```

传输模型用 `model_dump(mode="json", exclude_unset=True)`，保留显式 null；不要统一删除 null，部分字段是必填但可空。

## 契约生成与验证

```sh
pnpm contracts:export
pnpm contracts:python
pnpm contracts:check
services/intelligence/.venv/bin/python services/intelligence/scripts/generate_models.py --check
pnpm test:contracts
pnpm test:intelligence
pnpm --filter @ai-qa/worker test
```

最后一项包括真实 Python HTTP 往返，以及需要本地 Docker/PostgreSQL 的作业测试。单独的 Python 测试不需要数据库或真实模型；CI 检查生成物和两端公共样例。新增字段先改 Zod 源定义，经 A 汇总后重新生成，不维护第二套手写数据结构。

## 容器入口

```sh
docker compose --profile intelligence up --build intelligence
```

容器内 worker 使用 `http://intelligence:7500`，证据目录只读挂载。Dockerfile 已提供，本轮仅验证本地进程路径；镜像构建/部署单独验收。不要挂载整个仓库或给 Python 配置数据库权限。
