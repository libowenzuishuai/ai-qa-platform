ALTER TABLE "ReleaseDecision" ADD COLUMN "idempotencyKey" TEXT, ADD COLUMN "requestFingerprint" TEXT;
CREATE UNIQUE INDEX "ReleaseDecision_projectId_idempotencyKey_key" ON "ReleaseDecision"("projectId","idempotencyKey");
