-- DropForeignKey
ALTER TABLE "CaseAttempt" DROP CONSTRAINT "CaseAttempt_runId_fkey";

-- AlterTable
ALTER TABLE "CaseAttempt" ADD COLUMN     "projectId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "TestCaseVersion" ADD COLUMN     "projectId" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Baseline_id_projectId_key" ON "Baseline"("id", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "Environment_id_projectId_key" ON "Environment"("id", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "Run_id_projectId_key" ON "Run"("id", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "TestCaseVersion_id_projectId_key" ON "TestCaseVersion"("id", "projectId");

-- AddForeignKey
ALTER TABLE "Run" ADD CONSTRAINT "Run_baselineId_projectId_fkey" FOREIGN KEY ("baselineId", "projectId") REFERENCES "Baseline"("id", "projectId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Run" ADD CONSTRAINT "Run_environmentId_projectId_fkey" FOREIGN KEY ("environmentId", "projectId") REFERENCES "Environment"("id", "projectId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseAttempt" ADD CONSTRAINT "CaseAttempt_runId_projectId_fkey" FOREIGN KEY ("runId", "projectId") REFERENCES "Run"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseAttempt" ADD CONSTRAINT "CaseAttempt_caseVersionId_projectId_fkey" FOREIGN KEY ("caseVersionId", "projectId") REFERENCES "TestCaseVersion"("id", "projectId") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------- 版本不可变保护（评审 R6）----------
-- 已批准（APPROVED）的 RuleVersion / TestCaseVersion 语义字段不可原地修改；
-- 只允许工作流字段（reviewStatus/approvalStatus、审核人、审核时间）变更。
-- 修订必须追加新版本并指向 supersedesId（PRD FR-03/FR-04）。

CREATE OR REPLACE FUNCTION "aiqa_protect_rule_version"() RETURNS trigger AS $$
BEGIN
  IF OLD."reviewStatus" = 'APPROVED' AND NEW."reviewStatus" = 'APPROVED' THEN
    IF NEW."statement" IS DISTINCT FROM OLD."statement"
       OR NEW."classification" IS DISTINCT FROM OLD."classification"
       OR NEW."role" IS DISTINCT FROM OLD."role"
       OR NEW."precondition" IS DISTINCT FROM OLD."precondition"
       OR NEW."action" IS DISTINCT FROM OLD."action"
       OR NEW."condition" IS DISTINCT FROM OLD."condition"
       OR NEW."expectation" IS DISTINCT FROM OLD."expectation"
       OR NEW."forbiddenBehaviors"::jsonb IS DISTINCT FROM OLD."forbiddenBehaviors"::jsonb
       OR NEW."priority" IS DISTINCT FROM OLD."priority"
       OR NEW."businessFields"::jsonb IS DISTINCT FROM OLD."businessFields"::jsonb
       OR NEW."sources"::jsonb IS DISTINCT FROM OLD."sources"::jsonb
       OR NEW."conflictsWith"::jsonb IS DISTINCT FROM OLD."conflictsWith"::jsonb
       OR NEW."supersedesId" IS DISTINCT FROM OLD."supersedesId"
       OR NEW."ruleId" IS DISTINCT FROM OLD."ruleId"
       OR NEW."version" IS DISTINCT FROM OLD."version"
    THEN
      RAISE EXCEPTION 'RuleVersion % 已批准，语义字段不可原地修改（IMMUTABLE_SEMANTIC_FIELDS）', OLD."id";
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_RuleVersion_immutable"
BEFORE UPDATE ON "RuleVersion"
FOR EACH ROW EXECUTE FUNCTION "aiqa_protect_rule_version"();

CREATE OR REPLACE FUNCTION "aiqa_protect_test_case_version"() RETURNS trigger AS $$
BEGIN
  IF OLD."approvalStatus" = 'APPROVED' AND NEW."approvalStatus" = 'APPROVED' THEN
    IF NEW."title" IS DISTINCT FROM OLD."title"
       OR NEW."description" IS DISTINCT FROM OLD."description"
       OR NEW."ruleVersionIds" IS DISTINCT FROM OLD."ruleVersionIds"
       OR NEW."roles" IS DISTINCT FROM OLD."roles"
       OR NEW."preconditions"::jsonb IS DISTINCT FROM OLD."preconditions"::jsonb
       OR NEW."dataSpec"::jsonb IS DISTINCT FROM OLD."dataSpec"::jsonb
       OR NEW."steps"::jsonb IS DISTINCT FROM OLD."steps"::jsonb
       OR NEW."assertions"::jsonb IS DISTINCT FROM OLD."assertions"::jsonb
       OR NEW."cleanup"::jsonb IS DISTINCT FROM OLD."cleanup"::jsonb
       OR NEW."priority" IS DISTINCT FROM OLD."priority"
       OR NEW."supersedesId" IS DISTINCT FROM OLD."supersedesId"
       OR NEW."caseId" IS DISTINCT FROM OLD."caseId"
       OR NEW."version" IS DISTINCT FROM OLD."version"
       OR NEW."projectId" IS DISTINCT FROM OLD."projectId"
       OR NEW."approvalHash" IS DISTINCT FROM OLD."approvalHash"
    THEN
      RAISE EXCEPTION 'TestCaseVersion % 已批准，语义字段不可原地修改（IMMUTABLE_SEMANTIC_FIELDS）', OLD."id";
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_TestCaseVersion_immutable"
BEFORE UPDATE ON "TestCaseVersion"
FOR EACH ROW EXECUTE FUNCTION "aiqa_protect_test_case_version"();
