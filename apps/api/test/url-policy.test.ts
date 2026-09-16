import { describe, expect, it } from "vitest";
import { normalizeHttpOrigin, validateEnvironmentOrigins } from "../src/url-policy.js";

/**
 * R2 回归：域名白名单必须按规范化 origin 精确比较。
 * 以下用例在修改前（startsWith 前缀匹配）会被错误放行。
 */

const ALLOWED = ["https://qa.example.com"];

describe("normalizeHttpOrigin", () => {
  it("默认端口归一化（https 443 / http 80）", () => {
    expect(normalizeHttpOrigin("https://qa.example.com")).toEqual({
      ok: true,
      origin: "https://qa.example.com",
    });
    expect(normalizeHttpOrigin("https://qa.example.com:443")).toEqual({
      ok: true,
      origin: "https://qa.example.com",
    });
    expect(normalizeHttpOrigin("http://qa.example.com:80/x")).toEqual({
      ok: true,
      origin: "http://qa.example.com",
    });
  });

  it("非默认端口保留在 origin 中", () => {
    expect(normalizeHttpOrigin("https://qa.example.com:8443/x")).toEqual({
      ok: true,
      origin: "https://qa.example.com:8443",
    });
  });

  it("拒绝非 http(s) 协议", () => {
    expect(normalizeHttpOrigin("file:///etc/passwd").ok).toBe(false);
    expect(normalizeHttpOrigin("ftp://qa.example.com").ok).toBe(false);
    expect(normalizeHttpOrigin("javascript:alert(1)").ok).toBe(false);
  });

  it("拒绝 userinfo", () => {
    const result = normalizeHttpOrigin("https://qa.example.com@attacker.invalid/orders");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/userinfo/);
  });

  it("拒绝无法解析的输入", () => {
    expect(normalizeHttpOrigin("not a url").ok).toBe(false);
  });
});

describe("validateEnvironmentOrigins —— 评审 R2 攻击行", () => {
  it("正常域名（含路径）通过", () => {
    expect(validateEnvironmentOrigins("https://qa.example.com/orders", ALLOWED)).toEqual({
      ok: true,
      baseUrlOrigin: "https://qa.example.com",
    });
  });

  it("相似但不同的域名被拒绝（前缀拼接欺骗）", () => {
    const result = validateEnvironmentOrigins(
      "https://qa.example.com.attacker.invalid/orders",
      ALLOWED,
    );
    expect(result.ok).toBe(false);
  });

  it("userinfo 欺骗 URL 被拒绝（真实 origin 是 attacker.invalid）", () => {
    expect(
      new URL("https://qa.example.com@attacker.invalid/orders").origin,
    ).toBe("https://attacker.invalid"); // 语义确认：浏览器实际访问 attacker.invalid
    const result = validateEnvironmentOrigins(
      "https://qa.example.com@attacker.invalid/orders",
      ALLOWED,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe("baseUrl");
  });

  it("不同端口被拒绝", () => {
    const result = validateEnvironmentOrigins("https://qa.example.com:444/orders", ALLOWED);
    expect(result.ok).toBe(false);
  });

  it("协议不同被拒绝（http ≠ https）", () => {
    expect(validateEnvironmentOrigins("http://qa.example.com/", ALLOWED).ok).toBe(false);
  });

  it("协议相对路径 baseUrl 被拒绝（无法解析为绝对 URL 或解析到错误源）", () => {
    expect(validateEnvironmentOrigins("//qa.example.com/", ALLOWED).ok).toBe(false);
  });

  it("白名单条目本身不合法时拒绝并指向 allowedOrigins 字段", () => {
    const result = validateEnvironmentOrigins("https://qa.example.com/", [
      "https://qa.example.com",
      "not a url",
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe("allowedOrigins");
  });

  it("同站不同端口可用显式白名单登记", () => {
    expect(
      validateEnvironmentOrigins("http://127.0.0.1:7400", ["http://127.0.0.1:7400"]),
    ).toEqual({ ok: true, baseUrlOrigin: "http://127.0.0.1:7400" });
  });
});
