import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  ImpactAnalysisInput,
  ImpactAnalysisOutput,
  SourceComparisonInput,
  SourceChangeReport,
  validateImpactAnalysis,
  validateSourceComparison,
} from "../src/index.js";
const vectors = JSON.parse(
  readFileSync(
    new URL("../fixtures/source-impact-conformance.json", import.meta.url),
    "utf8",
  ),
);
describe("B2/C3 shared conformance", () => {
  for (const v of vectors)
    it(v.name, () => {
      let ok = false;
      try {
        ok =
          v.kind === "source"
            ? validateSourceComparison(
                SourceComparisonInput.parse(v.input),
                SourceChangeReport.parse(v.output),
              ).ok
            : validateImpactAnalysis(
                ImpactAnalysisInput.parse(v.input),
                ImpactAnalysisOutput.parse(v.output),
              ).ok;
      } catch {
        ok = false;
      }
      expect(ok).toBe(v.valid);
    });
});
