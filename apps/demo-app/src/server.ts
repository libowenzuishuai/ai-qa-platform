import Fastify from "fastify";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import { randomUUID } from "node:crypto";
import { loadConfig, hasBug, hasFault, type DemoConfig } from "./config.js";
import {
  APPROVAL_THRESHOLD_CENTS,
  STATUS_LABEL,
  centsToYuanDisplay,
  findUserById,
  findUserByUsername,
  generateOrderId,
  openDatabase,
  parseYuanToCents,
  verifyPassword,
  type DemoOrder,
  type DemoUserRow,
} from "./db.js";
import {
  errorPage,
  loginPage,
  newOrderPage,
  orderDetailPage,
  ordersPage,
  paymentsPage,
} from "./render.js";

/**
 * 采购审批 demo-app —— 独立待测系统。
 *
 * 健康业务规则（PRD §12.1）：
 * - 金额单位为分；
 * - 金额 > 500000 分需主管审批；
 * - 金额 <= 500000 分直接进入付款待办；
 * - 禁止申请人审批。
 *
 * 缺陷模式（仅评测器可见，通过 DEMO_BUG_MODES 配置）：
 * - B1 阈值写错：边界判断写成 >=，恰好 5000.00 元（500000 分）被放行进入付款待办；
 * - B2 越权审批：服务端不再拒绝申请人审批；
 * - B3 付款状态不同步：审批后状态停在“已审批”，付款待办不更新；
 * - B4 数据未持久化：提交返回成功但不落库，刷新后数据丢失。
 */

const config = loadConfig();

interface Session {
  userId: string;
  createdAt: number;
}
/** 会话保存在内存（演示系统）；业务数据全部落 SQLite。 */
const sessions = new Map<string, Session>();

const db = openDatabase(config);

const app = Fastify({
  logger: { level: process.env.DEMO_LOG_LEVEL ?? "info" },
  bodyLimit: 1024 * 64,
});
await app.register(cookie);
await app.register(formbody);

// 评测夹具接口鉴权：必须在路由注册前声明，令牌错误直接拒绝。
app.addHook("onRequest", async (req, reply) => {
  if (!req.url.startsWith("/api/fixtures/")) return;
  const token = req.headers["x-fixture-token"];
  if (token !== config.fixtureToken) {
    return reply.code(403).send({ error: "FORBIDDEN", message: "评测令牌无效" });
  }
});

// ---------- 会话辅助 ----------

function currentUser(req: { cookies: Record<string, string | undefined> }): DemoUserRow | null {
  const sid = req.cookies["demo_sid"];
  if (!sid) return null;
  const session = sessions.get(sid);
  if (!session) return null;
  return findUserById(db, session.userId) ?? null;
}

function navUser(user: DemoUserRow | null) {
  return user ? { displayName: user.display_name, role: user.role } : null;
}

function requireLogin(
  req: { cookies: Record<string, string | undefined> },
  redirect = "/login",
): { user: DemoUserRow } | { redirect: string } {
  const user = currentUser(req);
  if (!user) return { redirect };
  return { user };
}

// ---------- 页面路由 ----------

app.get("/health", async () => ({ ok: true }));

app.get("/", async (req, reply) => {
  const auth = requireLogin(req);
  if ("redirect" in auth) return reply.redirect(auth.redirect);
  return reply.redirect("/orders");
});

app.get("/login", async (req, reply) => {
  const user = currentUser(req);
  if (user) return reply.redirect("/orders");
  return reply.type("text/html").send(loginPage());
});

app.post("/login", async (req, reply) => {
  const body = req.body as Record<string, string> | undefined;
  const username = (body?.username ?? "").trim();
  const password = body?.password ?? "";
  const user = username ? findUserByUsername(db, username) : undefined;
  if (!user || !verifyPassword(password, user.password_hash)) {
    return reply.code(401).type("text/html").send(loginPage("用户名或密码错误"));
  }
  const sid = randomUUID();
  sessions.set(sid, { userId: user.id, createdAt: Date.now() });
  reply.setCookie("demo_sid", sid, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
  });
  return reply.redirect("/orders");
});

app.post("/logout", async (req, reply) => {
  const sid = req.cookies.demo_sid;
  if (sid) sessions.delete(sid);
  reply.clearCookie("demo_sid", { path: "/" });
  return reply.redirect("/login");
});

app.get("/orders", async (req, reply) => {
  const auth = requireLogin(req);
  if ("redirect" in auth) return reply.redirect(auth.redirect);
  const ns = req.cookies["demo_ns"] ?? null;
  const orders = ns
    ? (db
        .prepare("SELECT * FROM orders WHERE namespace = ? ORDER BY created_at DESC LIMIT 200")
        .all(ns) as unknown as DemoOrder[])
    : (db
        .prepare("SELECT * FROM orders ORDER BY created_at DESC LIMIT 200")
        .all() as unknown as DemoOrder[]);
  return reply.type("text/html").send(ordersPage(navUser(auth.user)!, orders));
});

app.get("/orders/new", async (req, reply) => {
  const auth = requireLogin(req);
  if ("redirect" in auth) return reply.redirect(auth.redirect);
  return reply.type("text/html").send(newOrderPage(navUser(auth.user)!));
});

/** 是否需要主管审批（分）。 */
function requiresApproval(amountCents: number): boolean {
  if (hasBug(config, "B1")) {
    // B1：阈值写错（> 误写成 >=），恰好 500000 分被错误送入审批。
    return amountCents >= APPROVAL_THRESHOLD_CENTS;
  }
  return amountCents > APPROVAL_THRESHOLD_CENTS;
}

app.post("/orders", async (req, reply) => {
  const auth = requireLogin(req);
  if ("redirect" in auth) return reply.redirect(auth.redirect);
  const body = req.body as Record<string, string> | undefined;
  const title = (body?.title ?? "").trim();
  const amountYuan = body?.amountYuan ?? "";
  const note = (body?.note ?? "").trim();
  if (!title) {
    return reply.code(422).type("text/html").send(newOrderPage(navUser(auth.user)!, "标题不能为空"));
  }
  const amountCents = parseYuanToCents(amountYuan);
  if (amountCents === null) {
    return reply
      .code(422)
      .type("text/html")
      .send(newOrderPage(navUser(auth.user)!, "金额格式不正确：请输入最多两位小数的数字"));
  }

  if (hasBug(config, "B4")) {
    // B4：页面显示创建成功，但数据不落库。
    const fakeId = generateOrderId();
    return reply
      .type("text/html")
      .send(
        orderDetailPage(navUser(auth.user)!, fakeOrder(fakeId, title, amountCents, auth.user.id), false, {
          kind: "success",
          text: "采购单创建成功",
        }),
      );
  }

  const id = generateOrderId();
  // 测试命名空间：由执行器通过 Cookie 注入（非凭据），用于按 attempt 隔离数据。
  const namespace = req.cookies["demo_ns"] ?? null;
  db.prepare(
    `INSERT INTO orders (id, title, amount_cents, note, status, created_by, created_at, namespace)
     VALUES (?, ?, ?, ?, 'DRAFT', ?, ?, ?)`,
  ).run(id, title, amountCents, note || null, auth.user.id, new Date().toISOString(), namespace);
  return reply.redirect(`/orders/${id}`);
});

app.get("/orders/:id", async (req, reply) => {
  const auth = requireLogin(req);
  if ("redirect" in auth) return reply.redirect(auth.redirect);
  const { id } = req.params as { id: string };
  const order = getOrder(id);
  if (!order) {
    return reply.code(404).type("text/html").send(errorPage(navUser(auth.user), 404, `采购单 ${id} 不存在`));
  }
  return reply.type("text/html").send(
    orderDetailPage(navUser(auth.user)!, order, auth.user.role === "supervisor"),
  );
});

app.post("/orders/:id/submit", async (req, reply) => {
  const auth = requireLogin(req);
  if ("redirect" in auth) return reply.redirect(auth.redirect);
  const { id } = req.params as { id: string };
  const order = getOrder(id);
  if (!order) {
    return reply.code(404).type("text/html").send(errorPage(navUser(auth.user), 404, `采购单 ${id} 不存在`));
  }
  if (order.status !== "DRAFT") {
    return reply.code(409).type("text/html").send(errorPage(navUser(auth.user), 409, `当前状态（${STATUS_LABEL[order.status]}）不允许提交`));
  }
  if (order.created_by !== auth.user.id) {
    return reply.code(403).type("text/html").send(errorPage(navUser(auth.user), 403, "只有创建人可以提交该采购单"));
  }
  const nextStatus = requiresApproval(order.amount_cents) ? "PENDING_APPROVAL" : "AWAITING_PAYMENT";
  const now = new Date().toISOString();
  db.prepare("UPDATE orders SET status = ?, submitted_at = ? WHERE id = ?").run(nextStatus, now, id);
  logApproval(id, auth.user.id, "submit", null, now);
  if (hasFault(config, "submit-commit-hang")) {
    // 故障注入（评测器专用）：数据已提交，但响应挂起 —— 模拟"提交后响应中断"。
    await new Promise((resolve) => setTimeout(resolve, 60_000));
    return reply.redirect(`/orders/${id}`);
  }
  return reply.redirect(`/orders/${id}`);
});

app.post("/orders/:id/approve", async (req, reply) => {
  const auth = requireLogin(req);
  if ("redirect" in auth) return reply.redirect(auth.redirect);
  const { id } = req.params as { id: string };
  const order = getOrder(id);
  if (!order) {
    return reply.code(404).type("text/html").send(errorPage(navUser(auth.user), 404, `采购单 ${id} 不存在`));
  }

  // 健康规则：禁止申请人审批。
  if (auth.user.role !== "supervisor" && !hasBug(config, "B2")) {
    return reply
      .code(403)
      .type("text/html")
      .send(errorPage(navUser(auth.user), 403, "申请人不可审批采购单"));
  }
  if (order.status !== "PENDING_APPROVAL") {
    return reply.code(409).type("text/html").send(errorPage(navUser(auth.user), 409, `当前状态（${STATUS_LABEL[order.status]}）不允许审批`));
  }

  const now = new Date().toISOString();
  if (hasBug(config, "B3")) {
    // B3：审批动作成功、状态停在“已审批”，但付款待办不更新。
    db.prepare(
      "UPDATE orders SET status = 'APPROVED', approved_by = ?, approved_at = ? WHERE id = ?",
    ).run(auth.user.id, now, id);
  } else {
    db.prepare(
      "UPDATE orders SET status = 'AWAITING_PAYMENT', approved_by = ?, approved_at = ? WHERE id = ?",
    ).run(auth.user.id, now, id);
  }
  logApproval(id, auth.user.id, "approve", null, now);
  return reply.redirect(`/orders/${id}`);
});

app.post("/orders/:id/reject", async (req, reply) => {
  const auth = requireLogin(req);
  if ("redirect" in auth) return reply.redirect(auth.redirect);
  const { id } = req.params as { id: string };
  const order = getOrder(id);
  if (!order) {
    return reply.code(404).type("text/html").send(errorPage(navUser(auth.user), 404, `采购单 ${id} 不存在`));
  }
  if (auth.user.role !== "supervisor") {
    return reply
      .code(403)
      .type("text/html")
      .send(errorPage(navUser(auth.user), 403, "申请人不可审批采购单"));
  }
  if (order.status !== "PENDING_APPROVAL") {
    return reply.code(409).type("text/html").send(errorPage(navUser(auth.user), 409, `当前状态（${STATUS_LABEL[order.status]}）不允许驳回`));
  }
  const body = req.body as Record<string, string> | undefined;
  const reason = (body?.reason ?? "").trim() || "未填写原因";
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE orders SET status = 'REJECTED', rejected_reason = ? WHERE id = ?",
  ).run(reason, id);
  logApproval(id, auth.user.id, "reject", reason, now);
  return reply.redirect(`/orders/${id}`);
});

app.get("/payments", async (req, reply) => {
  const auth = requireLogin(req);
  if ("redirect" in auth) return reply.redirect(auth.redirect);
  const ns = req.cookies["demo_ns"] ?? null;
  const orders = ns
    ? (db
        .prepare(
          "SELECT * FROM orders WHERE status = 'AWAITING_PAYMENT' AND namespace = ? ORDER BY approved_at DESC LIMIT 200",
        )
        .all(ns) as unknown as DemoOrder[])
    : (db
        .prepare(
          "SELECT * FROM orders WHERE status = 'AWAITING_PAYMENT' ORDER BY approved_at DESC LIMIT 200",
        )
        .all() as unknown as DemoOrder[]);
  return reply.type("text/html").send(paymentsPage(navUser(auth.user)!, orders));
});

// ---------- 评测夹具接口（仅评测器使用；鉴权 hook 已在上方注册） ----------

/** 受控数据初始化/清理：清空全部采购单与审批记录，保留账号。 */
app.post("/api/fixtures/reset", async () => {
  db.exec("DELETE FROM approval_log; DELETE FROM orders;");
  return { ok: true };
});

/** 按命名空间清理（阶段 1 数据隔离；不触碰其它 namespace 与手工数据）。 */
app.post("/api/fixtures/ns/reset", async (req) => {
  const body = req.body as { namespace?: string } | undefined;
  const namespace = body?.namespace?.trim();
  if (!namespace || namespace.length > 128) {
    return { ok: false, error: "VALIDATION_ERROR", message: "namespace 必填且不超过 128 字符" };
  }
  // 先删审批日志再删订单（approval_log 外键引用 orders）。
  db.prepare(
    "DELETE FROM approval_log WHERE order_id IN (SELECT id FROM orders WHERE namespace = ?)",
  ).run(namespace);
  const result = db.prepare(
    "DELETE FROM orders WHERE namespace = ?",
  ).run(namespace);
  return { ok: true, deleted: Number(result.changes) };
});

/** 读取命名空间内部状态（评测器断言用，不向测试智能体暴露）。 */
app.get("/api/fixtures/ns/state", async (req) => {
  const namespace = (req.query as { namespace?: string }).namespace?.trim();
  if (!namespace) {
    return { ok: false, error: "VALIDATION_ERROR", message: "namespace 必填" };
  }
  const orders = db
    .prepare("SELECT * FROM orders WHERE namespace = ? ORDER BY created_at")
    .all(namespace) as unknown as DemoOrder[];
  return {
    ok: true,
    orders: orders.map((o) => ({
      id: o.id,
      title: o.title,
      amountCents: o.amount_cents,
      status: o.status,
    })),
  };
});

/** 评测器读取内部订单状态（ground truth 断言用）。 */
app.get("/api/fixtures/orders", async () => {
  const orders = db.prepare("SELECT * FROM orders ORDER BY created_at DESC").all() as unknown as DemoOrder[];
  return {
    ok: true,
    orders: orders.map((o) => ({
      id: o.id,
      title: o.title,
      amountCents: o.amount_cents,
      status: o.status,
      createdBy: o.created_by,
    })),
  };
});

// ---------- 辅助 ----------

function getOrder(id: string): DemoOrder | undefined {
  return db.prepare("SELECT * FROM orders WHERE id = ?").get(id) as DemoOrder | undefined;
}

function logApproval(orderId: string, actor: string, action: string, note: string | null, at: string): void {
  db.prepare(
    "INSERT INTO approval_log (id, order_id, actor, action, note, at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(randomUUID(), orderId, actor, action, note, at);
}

function fakeOrder(id: string, title: string, amountCents: number, createdBy: string): DemoOrder {
  const now = new Date().toISOString();
  return {
    id,
    title,
    amount_cents: amountCents,
    note: null,
    status: "DRAFT",
    created_by: createdBy,
    created_at: now,
    submitted_at: null,
    approved_by: null,
    approved_at: null,
    rejected_reason: null,
    namespace: null,
  };
}

// 不暴露缺陷模式：任何 API 都不返回 DEMO_BUG_MODES。
app.listen({ port: config.port, host: config.host }).then(() => {
  app.log.info(`demo-app listening on http://${config.host}:${config.port}`);
  if (config.bugModes.size > 0) {
    app.log.warn(`[评测配置] 已启用缺陷模式: ${[...config.bugModes].join(",")}`);
  }
});
