ALTER TABLE "V2ExecutionSession"
  ADD COLUMN "targetBaseUrl" TEXT,
  ADD COLUMN "leaseToken" TEXT,
  ADD COLUMN "leaseExpiresAt" TIMESTAMP(3),
  ADD COLUMN "startedAt" TIMESTAMP(3),
  ADD COLUMN "checkpoint" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "result" JSONB;
ALTER TABLE "V2ActionIntent" ADD COLUMN "inputArtifactId" TEXT;

CREATE TABLE "V2SessionEvent" (
 "seq" SERIAL NOT NULL PRIMARY KEY,
 "sessionId" TEXT NOT NULL,
 "type" TEXT NOT NULL,
 "payload" JSONB NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "V2SessionEvent_sessionId_seq_idx" ON "V2SessionEvent"("sessionId", "seq");
