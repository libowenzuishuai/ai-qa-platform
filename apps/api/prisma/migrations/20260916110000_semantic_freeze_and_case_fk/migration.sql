-- DropForeignKey
ALTER TABLE "TestCaseVersion" DROP CONSTRAINT "TestCaseVersion_caseId_fkey";

-- AlterTable
ALTER TABLE "RuleVersion" ADD COLUMN     "semanticFrozen" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "TestCaseVersion" ADD COLUMN     "semanticFrozen" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE UNIQUE INDEX "TestCase_id_projectId_key" ON "TestCase"("id", "projectId");

-- AddForeignKey
ALTER TABLE "TestCaseVersion" ADD CONSTRAINT "TestCaseVersion_caseId_projectId_fkey" FOREIGN KEY ("caseId", "projectId") REFERENCES "TestCase"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------- F1：已批准过的版本永久冻结语义 ----------
-- 旧触发器只保护 OLD.status=APPROVED AND NEW.status=APPROVED，
-- 可被"同次改状态+改语义"或"先改状态再改语义"绕过。
-- 新机制：semanticFrozen 批准即置位、只增不减；冻结后语义字段任何
-- UPDATE（含退回 DRAFT、SUPERSEDED 后再改、重新批准前篡改）都被拒绝；
-- 工作流元数据（reviewStatus/approvalStatus、审核人/时间）仍可更新。

-- 回填：当前已批准/已被取代的版本视为曾批准过。
UPDATE "RuleVersion" SET "semanticFrozen" = true WHERE "reviewStatus" IN ('APPROVED', 'SUPERSEDED');
UPDATE "TestCaseVersion" SET "semanticFrozen" = true WHERE "approvalStatus" IN ('APPROVED', 'SUPERSEDED');

DROP TRIGGER IF EXISTS "trg_RuleVersion_immutable" ON "RuleVersion";
DROP FUNCTION IF EXISTS "aiqa_protect_rule_version"();
DROP TRIGGER IF EXISTS "trg_TestCaseVersion_immutable" ON "TestCaseVersion";
DROP FUNCTION IF EXISTS "aiqa_protect_test_case_version"();

CREATE OR REPLACE FUNCTION "aiqa_protect_rule_version"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."reviewStatus" = 'APPROVED' THEN
      NEW."semanticFrozen" := true;
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE：冻结只增不减。
  IF OLD."semanticFrozen" = true AND NEW."semanticFrozen" = false THEN
    RAISE EXCEPTION 'RuleVersion % 的语义冻结不可解除（IMMUTABLE_SEMANTIC_FIELDS）', OLD."id";
  END IF;
  IF NEW."reviewStatus" = 'APPROVED' THEN
    NEW."semanticFrozen" := true;
  END IF;
  IF OLD."semanticFrozen" = true THEN
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
      RAISE EXCEPTION 'RuleVersion % 曾被批准，语义字段永久不可修改（IMMUTABLE_SEMANTIC_FIELDS）', OLD."id";
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_RuleVersion_immutable"
BEFORE INSERT OR UPDATE ON "RuleVersion"
FOR EACH ROW EXECUTE FUNCTION "aiqa_protect_rule_version"();

CREATE OR REPLACE FUNCTION "aiqa_protect_test_case_version"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."approvalStatus" = 'APPROVED' THEN
      NEW."semanticFrozen" := true;
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."semanticFrozen" = true AND NEW."semanticFrozen" = false THEN
    RAISE EXCEPTION 'TestCaseVersion % 的语义冻结不可解除（IMMUTABLE_SEMANTIC_FIELDS）', OLD."id";
  END IF;
  IF NEW."approvalStatus" = 'APPROVED' THEN
    NEW."semanticFrozen" := true;
  END IF;
  IF OLD."semanticFrozen" = true THEN
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
      RAISE EXCEPTION 'TestCaseVersion % 曾被批准，语义字段永久不可修改（IMMUTABLE_SEMANTIC_FIELDS）', OLD."id";
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_TestCaseVersion_immutable"
BEFORE INSERT OR UPDATE ON "TestCaseVersion"
FOR EACH ROW EXECUTE FUNCTION "aiqa_protect_test_case_version"();
