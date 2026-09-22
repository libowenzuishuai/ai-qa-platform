ALTER TABLE "Defect" ADD COLUMN "severityBasis" TEXT;
CREATE INDEX "Defect_projectId_status_updatedAt_idx" ON "Defect"("projectId", "status", "updatedAt");
