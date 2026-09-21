ALTER TABLE "LoginPreparation" ADD COLUMN "configuration" JSONB, ADD COLUMN "lastCheckJobId" TEXT;
ALTER TABLE "DataPlugin" ADD COLUMN "environmentId" TEXT, ADD COLUMN "environmentRevision" INTEGER, ADD COLUMN "definition" JSONB, ADD COLUMN "environmentSnapshot" JSONB;
ALTER TABLE "DataResource" ADD COLUMN "parameters" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "WorkflowRun" ADD COLUMN "eventSeq" INTEGER NOT NULL DEFAULT 0, ADD COLUMN "idempotencyKey" TEXT, ADD COLUMN "inputFingerprint" TEXT;
UPDATE "WorkflowRun" SET "eventSeq" = COALESCE((SELECT MAX("seq") FROM "WorkflowEvent" WHERE "workflowId" = "WorkflowRun"."id"),0);
CREATE UNIQUE INDEX "WorkflowRun_projectId_idempotencyKey_key" ON "WorkflowRun"("projectId","idempotencyKey");
CREATE UNIQUE INDEX "WorkflowNode_workflowId_nodeKey_key" ON "WorkflowNode"("workflowId","nodeKey");
CREATE UNIQUE INDEX "DataResource_projectId_pluginId_namespace_action_key" ON "DataResource"("projectId","pluginId","namespace","action");
