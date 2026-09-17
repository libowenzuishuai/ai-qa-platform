import { createServer, request as httpRequest, type Server } from "node:http";
import { connect as netConnect } from "node:net";
import { checkDestination, type NavigationPolicy } from "./navigation-policy.js";

/**
 * 策略代理（评审 R1）：连接层网络隔离。
 *
 * 背景：仅靠 Playwright/CDP 的 context.route 拦截不足以保证"越界请求
 * 不发出"（评审用真实第二站点证明 302 目标可以收到请求）。本代理把
 * 浏览器（执行与观察流程）的全部流量（含重定向目标、service worker、
 * websocket 的 CONNECT）强制经由本地代理转发：
 *
 * - HTTP(S) 目的地在建立连接/转发前按 origin 白名单校验；
 * - 越界目标直接拒绝（403 / 断开 CONNECT），字节不会离开本机；
 * - 凭据只可能到达白名单内的目的地；
 * - 记录每次拦截（onViolation）与计数（测试断言"第二站点请求数为 0"）。
 *
 * 用法：chromium.launch({ proxy: { server: "per-context" } })，
 * 每个 context 传 { proxy: { server: proxy.url } }。
 */

export interface PolicyProxyStats {
  /** 按规范化 origin 统计的转发请求数。 */
  forwarded: Record<string, number>;
  /** 被拒绝的连接/请求数（按目标 origin）。 */
  blocked: Record<string, number>;
  /** 被拒绝目标的完整 URL 列表（测试与审计用）。 */
  blockedUrls: string[];
}

export interface PolicyProxy {
  url: string;
  port: number;
  stats(): PolicyProxyStats;
  close(): Promise<void>;
}

export function startPolicyProxy(
  policy: NavigationPolicy,
  onViolation?: (v: { kind: string; url: string; detail: string }) => void,
): Promise<PolicyProxy> {
  const sockets = new Set<import("node:stream").Duplex>();
  const track = (socket: import("node:stream").Duplex) => {
    if (sockets.has(socket)) return;
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };
  const stats: PolicyProxyStats = { forwarded: {}, blocked: {}, blockedUrls: [] };

  const recordBlocked = (origin: string, url: string, detail: string) => {
    stats.blocked[origin] = (stats.blocked[origin] ?? 0) + 1;
    stats.blockedUrls.push(url);
    onViolation?.({ kind: "proxy_blocked", url, detail });
  };
  const recordForwarded = (origin: string) => {
    stats.forwarded[origin] = (stats.forwarded[origin] ?? 0) + 1;
  };

  const server: Server = createServer((req, res) => {
    // 绝对形态的 HTTP 代理请求。
    const target = req.url ?? "";
    let parsed: URL;
    try {
      parsed = new URL(target);
    } catch {
      res.writeHead(400).end("malformed proxy request");
      return;
    }
    if (parsed.protocol !== "http:") {
      res.writeHead(400).end("HTTPS requires CONNECT");
      return;
    }
    const origin = `${parsed.protocol}//${parsed.host}`;
    const decision = checkDestination(target, policy);
    if (!decision.allowed) {
      recordBlocked(origin, target, `代理拒绝非白名单目标 ${origin}`);
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("blocked by destination policy");
      return;
    }
    recordForwarded(origin);
    const upstream = httpRequest(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname.replace(/^\[|\]$/g, ""),
        port: parsed.port || 80,
        method: req.method,
        path: parsed.pathname + parsed.search,
        headers: { ...req.headers, host: parsed.host },
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.on("socket", track);
    res.on("close", () => upstream.destroy());
    upstream.on("error", () => {
      res.destroy();
    });
    req.pipe(upstream);
  });

  // HTTPS CONNECT 隧道：先校验目的地，再建立上游连接。
  server.on("connect", (req, clientSocket, head) => {
    const hostPort = req.url ?? "";
    let target: URL;
    try {
      target = new URL(`https://${hostPort}`);
      if (target.username || target.password || target.pathname !== "/" || target.search || target.hash) throw new Error("invalid CONNECT");
    } catch {
      clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    const host = target.hostname.replace(/^\[|\]$/g, "");
    const port = Number(target.port || 443);
    if (port < 1 || port > 65535) {
      clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    const origin = target.origin;
    const decision = checkDestination(`${origin}/`, policy);
    if (!decision.allowed) {
      recordBlocked(origin, `connect://${hostPort}`, `代理拒绝非白名单 CONNECT ${origin}`);
      clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    recordForwarded(origin);
    const upstream = netConnect({ host, port }, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    track(upstream);
    clientSocket.on("close", () => upstream.destroy());
    upstream.on("close", () => clientSocket.destroy());
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });

  server.on("connection", track);

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        stats: () => ({
          forwarded: { ...stats.forwarded },
          blocked: { ...stats.blocked },
          blockedUrls: [...stats.blockedUrls],
        }),
        close: () =>
          new Promise<void>((resolveClose) => {
            server.close(() => resolveClose());
            // closeAllConnections 不关闭升级后的 CONNECT 隧道。
            for (const socket of sockets) socket.destroy();
            server.closeAllConnections?.();
          }),
      });
    });
  });
}
