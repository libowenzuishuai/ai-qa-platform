import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../src/index.js";

describe("ArtifactStore", () => {
  const dirs: string[] = [];
  const makeStore = () => {
    const dir = mkdtempSync(join(tmpdir(), "artstore-"));
    dirs.push(dir);
    return new ArtifactStore(dir);
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("put 写入受控路径并返回 checksum", () => {
    const store = makeStore();
    const result = store.put({
      runId: "run-1",
      attemptId: "att-1",
      filename: "step-001.png",
      data: Buffer.from("hello"),
    });
    expect(result.storageKey).toBe(join("run-1", "att-1", "step-001.png"));
    expect(result.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(result.size).toBe(5);
    expect(store.exists(result.storageKey)).toBe(true);
    expect(store.read(result.storageKey).toString()).toBe("hello");
  });

  it("拒绝目录穿越 storageKey", () => {
    const store = makeStore();
    expect(() => store.resolveSafe("../../etc/passwd")).toThrow(/目录穿越/);
    expect(() => store.resolveSafe("run/../../outside.png")).toThrow(/目录穿越/);
    expect(() => store.stream("/etc/passwd")).toThrow();
  });

  it("拒绝非法文件名与 id", () => {
    const store = makeStore();
    expect(() =>
      store.put({ runId: "r", attemptId: "a", filename: "../evil.png", data: Buffer.alloc(0) }),
    ).toThrow(/非法文件名/);
    expect(() =>
      store.put({ runId: "../r", attemptId: "a", filename: "x.png", data: Buffer.alloc(0) }),
    ).toThrow(/非法/);
  });

  it("exists 对不存在文件返回 false 而不是抛错", () => {
    const store = makeStore();
    expect(store.exists("no/such/file.png")).toBe(false);
  });
});
