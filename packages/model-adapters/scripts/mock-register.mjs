#!/usr/bin/env node
/**
 * 注册 mock 确定性响应（李琦双/测试用）。
 * 输入 JSON 文件：{ purpose, system, user, extra?, hint?, imageStorageKey?, response }
 * 键 = inputHash(purpose, system, user, extra)（视觉：purpose,"vision",hint,imageStorageKey）。
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TABLE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "mock-table",
  "entries.json",
);

const [inputFile] = process.argv.slice(2);
if (!inputFile) {
  console.error("用法: node scripts/mock-register.mjs <input.json>");
  process.exit(1);
}
const spec = JSON.parse(readFileSync(inputFile, "utf8"));
const extra = spec.extra ?? "";
const key = createHash("sha256")
  .update(
    spec.purpose === "VISION_DESCRIBE"
      ? `${spec.purpose}\nvision\n${spec.hint}\n${spec.imageStorageKey}`
      : `${spec.purpose}\n${spec.system}\n${spec.user}\n${extra}`,
  )
  .digest("hex");

const table = JSON.parse(readFileSync(TABLE, "utf8"));
table.entries[key] = spec.response;
mkdirSync(dirname(TABLE), { recursive: true });
writeFileSync(TABLE, JSON.stringify(table, null, 2) + "\n");
console.log("registered:", key);
