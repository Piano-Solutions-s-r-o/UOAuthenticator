SET lock_timeout = '5s';
SET statement_timeout = '120s';

CREATE TABLE "pending_registrations" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "domain" TEXT NOT NULL,
  "credential_hash" TEXT NOT NULL,
  "link_hash" TEXT NOT NULL UNIQUE,
  "code_hash" TEXT NOT NULL,
  "completion_hash" TEXT NOT NULL UNIQUE,
  "context_hash" TEXT NOT NULL,
  "config_hash" TEXT NOT NULL,
  "email_hash" TEXT NOT NULL,
  "login_restart_url" TEXT,
  "registration_restart_url" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0 CHECK ("attempts" BETWEEN 0 AND 5),
  "email_verified_at" TIMESTAMP(3),
  "browser_authorized_at" TIMESTAMP(3),
  "link_used_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "completed_user_id" TEXT,
  "completed_epoch" INTEGER,
  "continued_at" TIMESTAMP(3),
  "expires_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ("browser_authorized_at" IS NULL OR "email_verified_at" IS NOT NULL),
  CHECK (("completed_at" IS NULL) = ("completed_user_id" IS NULL)),
  CHECK (("completed_at" IS NULL) = ("completed_epoch" IS NULL)),
  CHECK ("continued_at" IS NULL OR "completed_at" IS NOT NULL)
);
CREATE INDEX "pending_registrations_expires_at_idx" ON "pending_registrations" ("expires_at");
CREATE INDEX "pending_registrations_context_hash_email_hash_idx" ON "pending_registrations" ("context_hash", "email_hash");
ALTER TABLE "pending_registrations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pending_registrations" FORCE ROW LEVEL SECURITY;
CREATE POLICY pending_registrations_deny_app ON "pending_registrations"
  FOR ALL TO uoa_app USING (false) WITH CHECK (false);
REVOKE ALL ON "pending_registrations" FROM uoa_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "pending_registrations" TO uoa_admin;
