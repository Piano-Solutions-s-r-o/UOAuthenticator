-- User avatar uploads (Docs/Auth/avatars.md §3). Purely additive: no existing table changes,
-- no data migration. `users.avatar_url` keeps its current meaning (the provider URL, overwritten
-- on every social login), and uploaded bytes live here so a later social login cannot clobber them.
--
-- RLS follows the per-user child-table classification used by `auth_identities`
-- (20260707104937) and `signature_claim_intents` (20260722153000): avatar reads and writes happen
-- on domain-hash, access-token, and admin paths that run before/outside a tenant context, so they
-- use the BYPASSRLS admin client and `uoa_app` is denied outright. Guarded with pg_roles checks so
-- local/dev databases without the RLS roles keep working unchanged.

CREATE TABLE "user_avatars" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "content_type" TEXT NOT NULL,
  "data" BYTEA NOT NULL,
  "size_bytes" INTEGER NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "user_avatars_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "user_avatars_size_bytes_check" CHECK ("size_bytes" > 0 AND "size_bytes" <= 1048576),
  CONSTRAINT "user_avatars_content_type_check"
    CHECK ("content_type" IN ('image/png', 'image/jpeg', 'image/webp'))
);

CREATE UNIQUE INDEX "user_avatars_user_id_key" ON "user_avatars"("user_id");

ALTER TABLE "user_avatars" ADD CONSTRAINT "user_avatars_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'uoa_app') THEN
    REVOKE ALL ON TABLE "user_avatars" FROM "uoa_app";
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'uoa_admin') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "user_avatars" TO "uoa_admin";
  END IF;
END
$$;

ALTER TABLE "user_avatars" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_avatars" FORCE ROW LEVEL SECURITY;
CREATE POLICY user_avatars_deny_app ON "user_avatars"
  FOR ALL TO uoa_app USING (false) WITH CHECK (false);
