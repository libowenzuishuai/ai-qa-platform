ALTER TABLE "DocumentVersion"
  ADD COLUMN "fileSizeBytes" INTEGER,
  ADD COLUMN "bundleStorageKey" TEXT,
  ADD COLUMN "bundleChecksum" TEXT,
  ADD COLUMN "parseWarnings" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE "RuleVersion" ADD COLUMN "generationMode" TEXT;
ALTER TABLE "TestCaseVersion" ADD COLUMN "generationMode" TEXT;
-- Recover provenance only where a completed job explicitly recorded it.
UPDATE "RuleVersion" AS r SET "generationMode" = j.request->>'mode'
FROM "Job" AS j WHERE j.kind = 'RULE_EXTRACTION' AND j.status = 'SUCCEEDED'
AND j.request->>'mode' IN ('real', 'mock') AND (j.result->'ruleVersionIds') ? r.id;
UPDATE "TestCaseVersion" AS c SET "generationMode" = j.request->>'mode'
FROM "Job" AS j WHERE j.kind = 'CASE_GENERATION' AND j.status = 'SUCCEEDED'
AND j.request->>'mode' IN ('real', 'mock') AND (j.result->'caseVersionIds') ? c.id;
