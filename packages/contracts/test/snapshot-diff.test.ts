import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { SnapshotDiffInput, validateSnapshotDiff } from "../src/index.js";
const corpus = JSON.parse(
  readFileSync(
    new URL("../fixtures/snapshot-diff-conformance.json", import.meta.url),
    "utf8",
  ),
);
describe("snapshot-diff-v1 shared conformance", () => {
  for (const v of corpus.vectors)
    it(v.name, () => {
      if (v.phase === "input")
        expect(SnapshotDiffInput.safeParse(v.input).success).toBe(false);
      else {
        const result = validateSnapshotDiff(v.input, v.report);
        expect(result.ok, JSON.stringify(result.problems)).toBe(v.valid);
      }
    });
});
