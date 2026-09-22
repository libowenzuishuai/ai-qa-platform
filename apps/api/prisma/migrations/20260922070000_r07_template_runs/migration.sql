-- AlterTable
ALTER TABLE "WorkflowRun" ADD COLUMN "templateId" TEXT;
ALTER TABLE "WorkflowNode" ADD COLUMN "capabilityKey" TEXT;
