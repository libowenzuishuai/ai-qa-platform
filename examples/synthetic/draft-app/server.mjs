/**
 * W04 合成草稿系统（synthetic，显式标记）：
 * 业务 = 创建草稿 → 改名 → 刷新仍保留名称。
 *
 * 构建注入（环境变量，仅评测方掌握）：
 * - DEFECT=rename_no_persist：改名接口返回成功但不落库（缺陷构建）。
 * - ROUTE_STYLE=v2：改名路由从 /api/drafts/:id/rename 换到 /api/drafts/:id/title
 *   （操作层定位变化——循环必须重新观察 /api/_meta 发现新入口，不得硬编码）。
 *
 * 运行：node server.mjs --port 9300
 */
import http from "node:http";
import { parse } from "node:url";

const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1] || 9300);
const DEFECT = process.env.DEFECT || "";
const ROUTE_STYLE = process.env.ROUTE_STYLE || "v1";

/** 持久层（进程内存 + 崩溃语义由评测方用进程级重启模拟）。 */
const drafts = new Map();
let seq = 0;

/** 运行中定位变化：收到 SWITCH_AFTER 次 rename 请求后入口切换（评测方注入）。 */
const SWITCH_AFTER = Number(process.env.SWITCH_AFTER || "0");
let renameRequests = 0;
const currentSegment = () => {
  const base = ROUTE_STYLE === "v2" ? "title" : "rename";
  if (!SWITCH_AFTER) return base;
  return renameRequests >= SWITCH_AFTER ? "title" : base;
};

const server = http.createServer((req, res) => {
  const url = parse(req.url, true);
  const json = (code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let parsed = {};
    try { parsed = body ? JSON.parse(body) : {}; } catch { return json(400, { error: "bad json" }); }
    if (url.pathname === "/api/_meta" && req.method === "GET") {
      // 观察入口：当前可用操作清单（定位层——业务标准不含这里）。
      return json(200, {
        system: "synthetic-draft",
        buildId: process.env.BUILD_ID || "synthetic-1",
        routes: {
          createDraft: "/api/drafts",
          renameDraft: `/api/drafts/:id/${currentSegment()}`,
          getDraft: "/api/drafts/:id",
        },
      });
    }
    if (url.pathname === "/api/drafts" && req.method === "POST") {
      // 幂等协作：Idempotency-Key 相同只创建一次。
      const idem = req.headers["idempotency-key"];
      if (idem && drafts.has(`idem:${idem}`)) {
        const existing = drafts.get(`idem:${idem}`);
        return json(200, { draft: existing, reused: true });
      }
      seq += 1;
      const draft = { id: `draft-${seq}`, title: String(parsed.title || "未命名草稿") };
      drafts.set(draft.id, draft);
      if (idem) drafts.set(`idem:${idem}`, draft);
      return json(201, { draft });
    }
    // W05：HTML 页面（DOM 观察 + 截图对象）。
    let ui;
    if ((ui = url.pathname.match(/^\/ui\/drafts\/([^/]+)$/)) && req.method === "GET") {
      const draft = drafts.get(ui[1]);
      if (!draft) { res.writeHead(404, { "content-type": "text/html" }); res.end("<h1>not found</h1>"); return; }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>草稿详情</title></head>
<body><main><h1 data-testid="draft-title">${String(draft.title).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]))}</h1>
<p data-testid="draft-id">${draft.id}</p></main></body></html>`);
      return;
    }
    let m;
    if ((m = url.pathname.match(/^\/api\/drafts\/([^/]+)$/)) && req.method === "GET") {
      const draft = drafts.get(m[1]);
      return draft ? json(200, { draft }) : json(404, { error: "not found" });
    }
    const renameMatch = url.pathname.match(/^\/api\/drafts\/([^/]+)\/(rename|title)$/);
    if (renameMatch && (req.method === "PATCH" || req.method === "PUT" || req.method === "POST")) {
      // 只有当前构建声明的入口可用；旧入口在 v2 下 404（定位确实变了）。
      renameRequests += 1;
      const activeSegment = currentSegment();
      if (renameMatch[2] !== activeSegment) return json(404, { error: "route moved" });
      const draft = drafts.get(renameMatch[1]);
      if (!draft) return json(404, { error: "not found" });
      if (DEFECT === "rename_no_persist") {
        // 缺陷构建：返回成功但不写持久层。
        return json(200, { draft: { ...draft, title: String(parsed.title ?? draft.title) }, persisted: false });
      }
      draft.title = String(parsed.title ?? draft.title);
      return json(200, { draft, persisted: true });
    }
    if (url.pathname === "/api/__danger_stats" && req.method === "GET") {
      // 仅评测器：资源计数（真实验收用，不在智能体能力面）。
      const realDrafts = [...drafts.entries()].filter(([k]) => !k.startsWith("idem:")).map(([, v]) => v);
      return json(200, { drafts: realDrafts.length, renameRequests });
    }
    if (url.pathname === "/api/__danger_reset" && req.method === "POST") {
      // 仅评测器使用；智能体能力清单不含该路由。
      drafts.clear();
      return json(200, { reset: true });
    }
    return json(404, { error: "no route" });
  });
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`synthetic-draft ready on http://127.0.0.1:${port} build=${process.env.BUILD_ID || "synthetic-1"}\n`);
});
