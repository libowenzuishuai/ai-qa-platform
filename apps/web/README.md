# apps/web：当前管理页面与 1.0 原型

当前已提供可运行的 Fastify SSR 管理页面，前端只调用平台 API，不直接访问数据库。不是 Next.js 占位应用。

- `src/pages.ts`：登录、项目、启动运行、进度、报告与证据。
- `src/workbench.ts`：资料上传/来源、规则审阅、澄清回答、用例草稿与作业状态。
- 启动：仓库根目录运行 `pnpm dev:web`，默认 http://127.0.0.1:7100；依赖平台 API 和对应配置。

`src/product.ts` 新增七个真实产品页面，入口 `/space/<projectId>`：GitHub 接入、上下文、用例/计划批准、任务/复测、缺陷与自有运行器。当前是可操作的功能版，完整视觉体验仍以原型为目标。实测与限制见 [交付记录](../../docs/delivery/v1-implementation.md)。

## 1.0 设计资料

- [产品 1.0 PRD](../../docs/product/v1.0/PRD.md)
- [交互原型说明](../../docs/product/v1.0/prototype/README.md)
- [原型入口](../../docs/product/v1.0/prototype/index.html)

原型是独立静态 HTML/CSS/JavaScript，可直接打开；使用示例数据，不连接平台 API，不执行实际仓库或模型操作。后续开发按验收模块逐步接入真实能力。
