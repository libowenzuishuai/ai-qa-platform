# Python 智能服务

平台为 TypeScript；文档解析与 agents 为 Python。完整分工见 [开工清单](../../docs/stage2-python-handoff.md)。Python 只返回解析产物/草稿/调用记录，平台负责鉴权、队列、状态和数据库。

## 当前状态

已提供服务、协议、生成类型、业务校验、模型网关、只读文件访问、测试与 TS 客户端。B 的首版 Python 文档解析已实现，`documentParse=true`；C 的规则提取与用例生成已实现，`ruleExtraction=true`、`caseGeneration=true`；A 已补公共来源质量与覆盖对账。文档上传与 DOCUMENT_PARSE 作业已接入平台，来源和解析文件由 worker 落库；最小审阅工作台已提供。

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

需要模型时设置现有 `AIQA_TEXT_*` / `AIQA_VISION_*` 环境变量。只有显式 real 调用会访问 Moonshot；mock 查表未命中直接失败。Python 网关目前严格 JSON 解析（修复次数为 0），不修改业务正文；网络协议用 mock transport 测试。2026-09-18 已完成 Kimi 2.6 真实文本连通和两页 PDF 视觉识别验证，见 [验收记录](../../docs/reviews/pdf-kimi-vision-2026-09-18.md)；这是历史视觉小样；C 正式生成验收见 [2026-09-20 合并记录](../../docs/reviews/python-agents-2026-09-20.md)。

## API 与 worker 切换

API 与 worker 同时设置 `AIQA_INTELLIGENCE_BACKEND=python`，worker 另需：

```sh
export AIQA_INTELLIGENCE_URL='http://127.0.0.1:7500'
export AIQA_INTELLIGENCE_TOKEN='与 Python 服务相同的令牌'
export AIQA_INTELLIGENCE_TIMEOUT_MS='120000'
```

默认 `python` 使用正式规则/用例管线，提示词版本 `agents-v2`。`reference` 只在显式配置时使用已有 TS 参考管线；Python 出错不会回退。缺内部 URL/令牌、模型配置或输出无效均明确失败。文档解析同时支持内部 HTTP 和平台上传作业，不受 reference 开关影响。

## 内部接口 v1

| 路径 | 请求 | 响应 |
|---|---|---|
| POST /v1/documents/parse | DocumentParseRequest | DocumentParseResponse |
| POST /v1/rules/extract | RuleExtractionRequest | RuleExtractionResponse |
| POST /v1/cases/generate | CaseGenerationRequest | CaseGenerationResponse |
| POST /v1/plans/propose | PlanProposalRequest | PlanProposalResponse |
| POST /v1/sources/classify | SourceClassificationRequest | SourceClassificationResponse |

均使用 `Authorization: Bearer <内部令牌>`。请求包含 schemaVersion=`1.0`、requestId、mode、timeoutMs、input；响应原样回传版本、请求 ID、mode，另有 output 与 invocations。文件通过只读共享目录的 storageKey、大小、SHA-256 引用，不传任意下载 URL。

NEEDS_OCR 是合法解析结果，HTTP 200 返回对应 bundle；下游规则提取拒绝它。错误体使用现有 code/message/requestId。健康接口不暴露凭据。

## 文档解析首版范围

- Markdown/TXT：UTF-8 原文与真实行号，标题/列表均有来源；Markdown 表格、代码块、图片/HTML 源文本标为 LOW，绝不加载外部资源。TXT 行号沿用契约的 markdown-line 定位。
- DOCX：正文段落索引保留空段落；表格按零起始 tableIndex/row/col 定位，合并单元格记录主单元格。嵌套表格内层按递增 tableIndex 递归解析；单元格内图片/修订仍 UNPARSED。页眉页脚等未提取时有警告。
- PDF：先读取真实页数/文字层，再将每一页完整渲染为 PNG，交给 Kimi 2.6 视觉模型；包含扫描页、同页多图、文字与图片混排以及矢量图形。不使用独立 OCR 引擎。模型全文保留为 `pdf-page` + LOW，扫描源保留 PDF_SCANNED 格式。模型表示识别不完整、无有效输出、渲染失败或超过页数预算时，均留下 UNPARSED 片段及具体页码警告；已有文字层只作为明确标记的局部回退。PARSED 表示有可用正文，不等于无遗漏，应同时查看 coverageSummary。
- PNG/JPEG：验证真实文件/格式/像素后走共享视觉网关。全文保留，整图归一化 bbox=[0,0,1,1]、LOW；无有效转录返回 NEEDS_OCR。凭据缺失/超时继续返回明确错误，不包装成解析成功。
- 视觉预算：每文档最多 20 页模型请求，每页最多 4096 输出 token，每次调用 60 秒、整份文档 120 秒（外层 HTTP/worker 更短预算优先）。模型返回 length/content_filter 等未完成响应即拒绝；不把截断 JSON 当有效正文。页面渲染最多 2048 像素长边、约 419 万像素、16 MB PNG、单页渲染 15 秒。正文总上限在模型回填后仍强制执行。Kimi 2.6 视觉请求关闭思考，使用 JSON mode。
- 上限：源文件 20 MB，PDF 200 页，提取文本 200 万字符/20000 块，图片 2000 万像素且单帧，视觉文本 10 万字符；DOCX 解压总量 64 MB/2000 条目，单 XML 16 MB。超限显式失败，不静默截断。
- CPU 解析每个服务进程最多两个子进程，请求超时/取消时终止实际子进程，整页渲染共用这两个名额。Linux 渲染子进程另限地址空间 1 GiB；其他系统依赖部署内存限制。服务部署使用只读证据目录和容器资源上限；本版没有做生产负载验收。

`pnpm test:doc-ingestion` 运行解析回归；依赖 pypdf（BSD-3-Clause）、pypdfium2（Apache-2.0/BSD-3-Clause，含 PDFium 第三方许可证）、python-docx（MIT）、Pillow（MIT-CMU）、defusedxml（PSF），lxml（BSD）为 DOCX 间接依赖。版本固定在 pyproject 和 requirements-dev.lock。PDFium wheel 提供本地页面渲染，不额外安装 Tesseract/PaddleOCR 等引擎。

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

## 显式真实模型验收

默认测试全部离线，不读取 `.env.local`，不会调用付费模型。手动验收只发送脚本生成的两页合成 PDF：

```sh
PYTHONPATH=services/intelligence/src services/intelligence/.venv/bin/python \
  services/intelligence/scripts/verify_kimi_vision.py --env-file .env.local
```

本地 `.env.local`（已被 Git 忽略）使用 `AIQA_VISION_PROVIDER=moonshot`、`AIQA_VISION_BASE_URL=https://api.moonshot.cn/v1`、`AIQA_VISION_MODEL=kimi-k2.6` 和自己的 `AIQA_VISION_API_KEY`。服务启动时将这些变量注入进程环境；脚本的 `--env-file` 不会自动影响其他进程。若本机设置了 SOCKS `ALL_PROXY` 但没有安装对应 httpx 可选依赖，可仅在该次命令前使用 `env -u ALL_PROXY -u all_proxy`；无需修改全局代理。

PDF/图片的 mock 或模式未知解析产物都不能进入 real 规则提取，API 和 worker 会重复检查。旧状态名 `NEEDS_OCR` 为兼容协议保留，界面含义是“待识别/人工复核”，不代表采用了 OCR 引擎。


### 正式规则 / 用例管线验收

```sh
PYTHONPATH=services/intelligence/src services/intelligence/.venv/bin/python \
  services/intelligence/scripts/verify_kimi_agents.py --env-file .env.local \
  --output /tmp/aiqa-kimi-agents.json
pnpm --filter @ai-qa/contracts exec node --import tsx scripts/verify-real-vectors.ts \
  /tmp/aiqa-kimi-agents.vectors.json
```

显式读取 `AIQA_TEXT_*` 凭据，只发送五套公开合成资料与一套已确认阈值规则；最多六次调用，失败即停止，不自动重试。输出保存实际 requestId、用量、提示词版本 / 源文件哈希、输入与模型结果供 TS 落库契约复验。文本 Kimi 2.6 请求关闭 thinking，最长 120 秒、输出最多 8192 token；超时、截断或不合法数据不修补为成功。

UNPARSED 不得成为任何规则来源，且必须出现在遗漏说明中；LOW 不能升级为 EXPLICIT。覆盖表必须与实际用例数和维度一致；没有用例时明确列阻塞。长文档先执行 150000 字符上限，不静默截断；自动分块尚未实现。

本地服务不会自动读取 `.env` / `.env.local`。启动前分别把配置注入 API/worker/Python 进程；模型凭据只需给 Python，内部令牌在 worker/Python 一致。Docker 启用 `intelligence` profile；完整应用容器化仍需单独验收。
