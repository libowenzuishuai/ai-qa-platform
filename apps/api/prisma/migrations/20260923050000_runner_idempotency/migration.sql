ALTER TABLE "CodeCheck" ADD COLUMN "idempotencyKey" TEXT;
CREATE UNIQUE INDEX "CodeCheck_projectId_idempotencyKey_key" ON "CodeCheck"("projectId", "idempotencyKey");
