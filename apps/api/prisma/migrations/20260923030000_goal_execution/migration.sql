ALTER TABLE "GoalProposal" ADD COLUMN "workflowId" TEXT, ADD COLUMN "executionRequest" JSONB;
CREATE UNIQUE INDEX "GoalProposal_workflowId_key" ON "GoalProposal"("workflowId");
ALTER TABLE "DiagnosisEntry" ADD COLUMN "sourceKey" TEXT;
CREATE UNIQUE INDEX "DiagnosisEntry_projectId_sourceKey_key" ON "DiagnosisEntry"("projectId", "sourceKey");
