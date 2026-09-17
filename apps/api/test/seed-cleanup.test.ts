import { createServer } from "node:http";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "./helpers/db.js";
import { seedFixedAssets } from "../../worker/src/seed-processor.js";

let env: TestEnv;
beforeAll(async () => { env = await createTestEnv("seed_cleanup"); });
afterAll(async () => { await env?.cleanup(); });

it("观察创建订单后失败，清理必须使用浏览器实际使用的唯一 namespace", async () => {
  const created: string[] = [], cleaned: string[] = [];
  const site = createServer((req, res) => {
    if (req.url === "/api/fixtures/ns/reset") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => { cleaned.push(JSON.parse(body).namespace); res.setHeader("content-type", "application/json"); res.end('{"ok":true,"deleted":1}'); });
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (req.url === "/login") {
      if (req.method === "POST") { res.writeHead(302, { location: "/orders" }).end(); return; }
      res.end('<form method="post"><input data-testid="login-username"><input type="password" data-testid="login-password"><button data-testid="login-submit">登录</button></form>');
    } else if (req.url === "/orders/new") {
      res.end('<form method="post" action="/orders"><input data-testid="title-input"><input data-testid="amount-input"><input data-testid="note-input"><button data-testid="create-submit">创建</button></form>');
    } else if (req.url === "/orders" && req.method === "POST") {
      created.push(/demo_ns=([^;]+)/.exec(req.headers.cookie ?? "")?.[1] ?? "");
      res.writeHead(302, { location: "/orders/one" }).end();
    } else if (req.url === "/orders/one") {
      // 故意缺少 submit-button：已创建数据，后续观察失败。
      res.end('<span data-testid="order-id">one</span><span data-testid="order-status">草稿</span>');
    } else {
      res.end('<a data-testid="nav-orders" href="/orders">订单</a><a data-testid="nav-new-order" href="/orders/new">新建</a><span data-testid="orders-count">0</span>');
    }
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
  const project = await env.prisma.project.create({ data: { name: "seed cleanup" } });
  const environment = await env.prisma.environment.create({ data: { projectId: project.id, name: "test", baseUrl, allowedOrigins: [baseUrl],
    secretRefs: { applicant: { usernameEnv: "REVIEW_SEED_USER", passwordEnv: "REVIEW_SEED_PASS" },
      supervisor: { usernameEnv: "REVIEW_SEED_USER", passwordEnv: "REVIEW_SEED_PASS" } },
  } });
  process.env.REVIEW_SEED_USER = "dummy-user";
  process.env.REVIEW_SEED_PASS = "dummy-password";
  try {
    await expect(seedFixedAssets(env.prisma, { databaseUrl: env.databaseUrl, artifactDir: env.artifactDir,
      port: 0, host: "127.0.0.1", redisUrl: "redis://127.0.0.1:1", demoFixtureToken: "dummy", logLevel: "silent",
    }, project.id, environment.id)).rejects.toThrow("观察失败");
    expect(created).toHaveLength(1);
    expect(created[0]).toMatch(/^seed-observe-/);
    expect(cleaned).toEqual(created);
  } finally {
    delete process.env.REVIEW_SEED_USER;
    delete process.env.REVIEW_SEED_PASS;
    site.closeAllConnections();
    await new Promise<void>((r) => site.close(() => r()));
  }
}, 20_000);
