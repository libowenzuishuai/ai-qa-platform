import { createServer, connect, type Socket } from "node:net";
import { once } from "node:events";
import { expect, it } from "vitest";
import { startPolicyProxy } from "../src/policy-proxy.js";

it("关闭代理会关闭仍在使用的 CONNECT 隧道，而不是永远等待", async () => {
  const sockets = new Set<Socket>();
  const target = createServer((socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
  const port = (target.address() as { port: number }).port;
  const proxy = await startPolicyProxy({ allowedOrigins: [`https://127.0.0.1:${port}`], dependencyOrigins: [] });
  const client = connect(proxy.port, "127.0.0.1");
  try {
    await once(client, "connect");
    client.write(`CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
    const [reply] = await once(client, "data");
    expect(String(reply)).toContain("200 Connection Established");
    const result = await Promise.race([
      proxy.close().then(() => "closed"),
      new Promise((r) => setTimeout(() => r("still-open"), 500)),
    ]);
    expect(result).toBe("closed");
  } finally {
    client.destroy();
    for (const socket of sockets) socket.destroy();
    await proxy.close();
    await new Promise<void>((r) => target.close(() => r()));
  }
});
