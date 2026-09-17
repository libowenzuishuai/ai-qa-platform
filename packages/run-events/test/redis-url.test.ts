import { describe, expect, it } from "vitest";
import { parseRedisConnection } from "../src/index.js";

describe("Redis URL", () => {
  it("保留身份、转义密码、数据库号与 TLS", () => {
    expect(parseRedisConnection("rediss://worker:p%40ss@cache.example:6380/3")).toEqual({
      host: "cache.example", port: 6380, username: "worker", password: "p@ss", db: 3, tls: true,
    });
  });
  it("拒绝非法数据库号，避免意外连接默认库", () => {
    expect(() => parseRedisConnection("redis://localhost/not-a-db")).toThrow();
    expect(() => parseRedisConnection("redis://localhost/-1")).toThrow();
  });
  it("IPv6 主机不把 URL 方括号交给网络 DNS", () => {
    expect(parseRedisConnection("redis://[::1]:6379/0").host).toBe("::1");
  });
});
