CREATE TABLE "ChangeReview" (
"id" TEXT PRIMARY KEY, "projectId" TEXT NOT NULL REFERENCES "Project"("id") ON DELETE RESTRICT,
"jobId" TEXT NOT NULL UNIQUE REFERENCES "Job"("id") ON DELETE RESTRICT,
"baselineId" TEXT NOT NULL, "oldDocumentVersionId" TEXT NOT NULL, "newDocumentVersionId" TEXT NOT NULL,
"input" JSONB NOT NULL, "inputHash" TEXT NOT NULL, "output" JSONB, "outputHash" TEXT,
"resolutions" JSONB NOT NULL DEFAULT '{}', "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
"updatedAt" TIMESTAMP(3) NOT NULL);
CREATE INDEX "ChangeReview_projectId_createdAt_idx" ON "ChangeReview"("projectId","createdAt");
CREATE FUNCTION guard_change_review_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW."projectId",NEW."jobId",NEW."baselineId",NEW."oldDocumentVersionId",NEW."newDocumentVersionId",NEW."input",NEW."inputHash") IS DISTINCT FROM ROW(OLD."projectId",OLD."jobId",OLD."baselineId",OLD."oldDocumentVersionId",OLD."newDocumentVersionId",OLD."input",OLD."inputHash") THEN RAISE EXCEPTION 'change review inputs are immutable'; END IF;
 IF OLD."output" IS NOT NULL AND ROW(NEW."output",NEW."outputHash") IS DISTINCT FROM ROW(OLD."output",OLD."outputHash") THEN RAISE EXCEPTION 'change review output is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER change_review_immutable BEFORE UPDATE ON "ChangeReview" FOR EACH ROW EXECUTE FUNCTION guard_change_review_immutable();
