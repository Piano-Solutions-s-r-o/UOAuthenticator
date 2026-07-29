-- Team ("company") avatar uploads (Docs/Auth/avatars.md §11). Purely additive: no existing table
-- changes, no data migration. `teams.icon_url` keeps its current meaning (an externally hosted
-- workspace icon, brief §15/design §11.3), and uploaded bytes live here so editing the icon URL
-- cannot clobber them — the exact shape of `user_avatars` (20260725120000), one row per team.
--
-- RLS follows the same classification as `user_avatars`: avatar reads and writes happen on
-- domain-hash, dual-auth and admin paths that run on the BYPASSRLS admin client (outside a tenant
-- transaction), so `uoa_app` is denied outright. Guarded with pg_roles checks so local/dev
-- databases without the RLS roles keep working unchanged.

CREATE TABLE "team_avatars" (
  "id" TEXT NOT NULL,
  "team_id" TEXT NOT NULL,
  "content_type" TEXT NOT NULL,
  "data" BYTEA NOT NULL,
  "size_bytes" INTEGER NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "team_avatars_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "team_avatars_size_bytes_check" CHECK ("size_bytes" > 0 AND "size_bytes" <= 1048576),
  CONSTRAINT "team_avatars_content_type_check"
    CHECK ("content_type" IN ('image/png', 'image/jpeg', 'image/webp'))
);

CREATE UNIQUE INDEX "team_avatars_team_id_key" ON "team_avatars"("team_id");

ALTER TABLE "team_avatars" ADD CONSTRAINT "team_avatars_team_id_fkey"
  FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'uoa_app') THEN
    REVOKE ALL ON TABLE "team_avatars" FROM "uoa_app";
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'uoa_admin') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "team_avatars" TO "uoa_admin";
  END IF;
END
$$;

ALTER TABLE "team_avatars" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "team_avatars" FORCE ROW LEVEL SECURITY;
CREATE POLICY team_avatars_deny_app ON "team_avatars"
  FOR ALL TO uoa_app USING (false) WITH CHECK (false);
