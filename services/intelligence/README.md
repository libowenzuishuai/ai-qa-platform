# Python 智能服务

平台为 TypeScript；文档解析与 agents 为 Python。完整分工见 [开工清单](../../docs/stage2-python-handoff.md)。Python 只返回解析产物/草稿/调用记录，平台负责鉴权、队列、状态和数据库。

## 当前状态

已提供服务、协议、生成类型、业务校验、模型网关、只读文件访问、测试与 TS 客户端。B 的首版 Python 文档解析已实现，`documentParse=true`；C 的规则/用例算法仍未实现，对应 capabilities=false、调用返回 503。文档上传与 DOCUMENT_PARSE 作业接线尚未完成。

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

默认 `reference` 是迁移兼容模式，继续使用已存在的 TS 参考管线；Python 出错不会回退。C 完成前切换 Python 的规则/用例管线仍会得到“模块待实现”的明确失败。文档解析可通过内部 HTTP 单独调用。

## 内部接口 v1

| 路径 | 请求 | 响应 |
|---|---|---|
| POST /v1/documents/parse | DocumentParseRequest | DocumentParseResponse |
| POST /v1/rules/extract | RuleExtractionRequest | RuleExtractionResponse |
| POST /v1/cases/generate | CaseGenerationRequest | CaseGenerationResponse |

均使用 `Authorization: Bearer <内部令牌>`。请求包含 schemaVersion=`1.0`、requestId、mode、timeoutMs、input；响应原样回传版本、请求 ID、mode，另有 output 与 invocations。文件通过只读共享目录的 storageKey、大小、SHA-256 引用，不传任意下载 URL。

NEEDS_OCR 是合法解析结果，HTTP 200 返回对应 bundle；下游规则提取拒绝它。错误体使用现有 code/message/requestId。健康接口不暴露凭据。

## 文档解析首版范围

- Markdown/TXT：UTF-8 原文与真实行号，标题/列表均有来源；Markdown 表格、代码块、图片/HTML 源文本标为 LOW，绝不加载外部资源。TXT 行号沿用契约的 markdown-line 定位。
- DOCX：正文段落索引保留空段落；表格按零起始 tableIndex/row/col 定位，合并单元格记录主单元格。段落编号只计正文直接段落、表格编号只计正文直接表格。嵌套表格、图片、修订、页眉页脚等遗漏有警告/可定位的 UNPARSED 记录，不宣称完整解析。
- PDF：按真实页号提取文字；空白或无法提取文字的页保留 UNPARSED。全部无文字时返回 PDF_SCANNED/NEEDS_OCR；混合文档保留可读文字与遗漏页。对含嵌入图像的无文字层页面尝试视觉 OCR（`pdf-page` + LOW）；无嵌入图像的空白/扫描页仍 NEEDS_OCR。复杂表格和多栏阅读顺序尚未实现。
- PNG/JPEG：验证真实文件/格式/像素后走共享视觉网关。全文保留，整图归一化 bbox=[0,0,1,1]、LOW；无有效转录返回 NEEDS_OCR。凭据缺失/超时继续返回明确错误，不包装成解析成功。
- 上限：源文件 20 MB，PDF 200 页，提取文本 200 万字符/20000 块，图片 2000 万像素且单帧，视觉文本 10 万字符；DOCX 解压总量 64 MB/2000 条目，单 XML 16 MB。超限显式失败，不静默截断。
- CPU 解析每个服务进程最多两个子进程，请求超时/取消时终止实际子进程。服务部署使用只读证据目录和容器资源上限；本版没有做生产负载验收。

`pnpm test:doc-ingestion` 运行解析回归；依赖 pypdf（BSD-3-Clause）、python-docx（MIT）、Pillow（MIT-CMU）、defusedxml（PSF），lxml（BSD）为 DOCX 间接依赖。版本固定在 pyproject 和 requirements-dev.lock。扫描 OCR 不额外安装系统工具。

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
