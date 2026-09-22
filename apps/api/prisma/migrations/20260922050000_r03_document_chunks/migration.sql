-- AlterTable
ALTER TABLE "DocumentVersion" ADD COLUMN "chunkManifest" JSONB,
ADD COLUMN "chunkManifestHash" TEXT;

-- CreateTable
CREATE TABLE "DocumentChunk" (
    "id" TEXT NOT NULL,
    "documentVersionId" TEXT NOT NULL,
    "manifestHash" TEXT NOT NULL,
    "chunkId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leaseExpiresAt" TIMESTAMP(3),
    "output" JSONB,
    "outputHash" TEXT,
    "invocations" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentChunk_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DocumentChunk_documentVersionId_manifestHash_chunkId_key" ON "DocumentChunk"("documentVersionId","manifestHash","chunkId");

-- CreateIndex
CREATE INDEX "DocumentChunk_documentVersionId_manifestHash_idx" ON "DocumentChunk"("documentVersionId","manifestHash");
