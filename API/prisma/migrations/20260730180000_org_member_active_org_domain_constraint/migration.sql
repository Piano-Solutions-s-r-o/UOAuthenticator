-- Follow-up to 20260730120000_org_backend_tenant_isolation. That migration is
-- already APPLIED IN PRODUCTION (merged and deployed 2026-07-30 15:40 UTC), and
-- Prisma records a checksum per applied migration, so it can no longer be edited
-- — a modified file makes the next `prisma migrate deploy` fail, and
-- `docker/start-production.sh` runs that at container boot under `set -eu`, which
-- would crash-loop the whole auth service. Everything it got wrong is therefore
-- corrected forward, here.
--
-- Four corrections:
--
--   1. The one-ACTIVE-org-per-user-per-domain invariant was enforced by a
--      BEFORE ROW trigger whose body SELECTs. At READ COMMITTED that is
--      check-then-write, not a constraint: two concurrent transactions each see
--      no conflict and both commit. Measured on this schema — two psql sessions,
--      overlapping transactions, both INSERTs committed ACTIVE rows for the same
--      user on the same domain. The trigger's own comment asserted the opposite.
--      Replaced with a partial unique index, which the planner enforces at index
--      insertion time and no interleaving can defeat.
--
--   2. That trigger raised ERRCODE 23505 naming
--      `org_members_one_active_org_per_domain` — a constraint that did not
--      exist. Prisma maps 23505 to P2002, no `/org/*` route handles it, so the
--      caller got a 500 quoting a phantom constraint. The index below now IS
--      that name, so the error names a real object.
--
--   3. No pre-flight. Applying onto already-violating data succeeded silently
--      and only failed later, on the next `status`-touching write. This
--      migration refuses to apply onto violating data and prints the offenders.
--
--   4. `uoa_org_domain(text)` / `uoa_org_owner_id(text)` were SECURITY DEFINER,
--      granted to `uoa_app`, and RETURNED another tenant's domain or owner id for
--      any org id — a read capability `uoa_app` did not previously have. They are
--      replaced by boolean predicates that only CONFIRM a value the caller
--      already supplied, and the old value-returning functions are dropped.
--
-- LOCKING. This migration and its predecessor DROP/CREATE policies and add
-- triggers, i.e. they take ACCESS EXCLUSIVE locks, while the OLD container is
-- still serving traffic. Postgres queues everything behind a waiting ACCESS
-- EXCLUSIVE, so one in-flight read is enough to stall every auth query for as
-- long as that read runs — measured at 10,110 ms for a plain
-- `SELECT count(*) FROM org_members` behind a 12 s reader. `lock_timeout` below
-- makes this migration ABORT instead of queueing the service behind it. Every
-- future migration in this repo that touches a live table must set it too.
--
-- IF THIS MIGRATION FAILS OR IS INTERRUPTED. The schema rolls back cleanly (one
-- transaction), but `_prisma_migrations` is left with `finished_at NULL,
-- rolled_back_at NULL`. The next boot then fails P3009 and, under
-- `set -eu`, the container aborts — a crash loop, not a degraded start. Recover
-- with, against DATABASE_ADMIN_URL:
--
--   npx prisma migrate resolve --rolled-back 20260730180000_org_member_active_org_domain_constraint
--
-- then redeploy. See Docs/deploy.md ("Recovering from a failed migration").
-- Note also that killing the `prisma` process does NOT kill its schema-engine
-- child: the engine can finish work ~20 s after the CI step reports failure, so
-- deploy status and database state can disagree. Always read `_prisma_migrations`
-- before acting on a failed deploy.
--
-- SCOPE, honestly stated. The domain binding added to the RLS policies covers
-- `access_requests` only. `organisations`, `org_members` and `teams` remain
-- org_id-keyed, so for those the "two independent layers" claim is really one
-- layer — `resolveOrganisationByDomain` in the service. That is pre-existing, not
-- a regression of either migration, and it is recorded here rather than fixed
-- silently or left implied.

-- =====================================================================
-- 0. Fail fast instead of queueing the service behind a lock.
-- =====================================================================
-- Prisma runs the file in one transaction, so these apply to all of it.
SET lock_timeout = '5s';
SET statement_timeout = '120s';

-- =====================================================================
-- 1. Pre-flight: refuse to apply onto data that already violates the
--    invariant we are about to make structural.
-- =====================================================================
--
-- Without this, `CREATE UNIQUE INDEX` fails with a bare "could not create
-- unique index ... duplicate key" naming no user. This names every offender so
-- an operator can act, and it runs before any DDL so nothing is half-done.
DO $$
DECLARE
  offenders bigint;
  sample text;
BEGIN
  -- Counted over EVERY violating pair, not over the sample: an operator reading
  -- "3 pairs" when there are 300 would plan the wrong remediation.
  SELECT count(*) INTO offenders FROM (
    SELECT 1
    FROM org_members om
    JOIN organisations o ON o.id = om.org_id
    WHERE om.status = 'ACTIVE'
    GROUP BY om.user_id, o.domain
    HAVING count(*) > 1
  ) v;

  IF offenders > 0 THEN
    SELECT string_agg(line, E'\n  ') INTO sample FROM (
      SELECT format('user %s on %s holds ACTIVE membership in: %s',
                    om.user_id, o.domain, string_agg(om.org_id, ', ' ORDER BY om.org_id)) AS line
      FROM org_members om
      JOIN organisations o ON o.id = om.org_id
      WHERE om.status = 'ACTIVE'
      GROUP BY om.user_id, o.domain
      HAVING count(*) > 1
      ORDER BY o.domain, om.user_id
      LIMIT 20
    ) capped;

    -- RAISE takes `%`, not `%s`. `%s` would print the value followed by a
    -- literal "s" and quietly corrupt the last org id in the list.
    RAISE EXCEPTION
      'cannot enforce one-active-organisation-per-user-per-domain: % (user, domain) pair(s) already violate it (first % shown):%',
      offenders,
      least(offenders, 20),
      E'\n  ' || sample
      USING HINT =
        'Resolve each pair before deploying: set every membership except the one to keep to '
        || 'status DEACTIVATED (and stamp status_changed_at). Re-run this query to confirm: '
        || 'SELECT om.user_id, o.domain, count(*) FROM org_members om JOIN organisations o '
        || 'ON o.id = om.org_id WHERE om.status = ''ACTIVE'' GROUP BY 1,2 HAVING count(*) > 1;';
  END IF;
END
$$;

-- =====================================================================
-- 2. Narrow the SECURITY DEFINER accessors from "return it" to "confirm it".
-- =====================================================================
--
-- The cycle these break is real and unchanged: `organisations_select`
-- subqueries `org_members`, so a policy on `org_members` that subqueries
-- `organisations` back makes PostgreSQL refuse the plan with 42P17. A SECURITY
-- DEFINER function's body is not RLS-expanded, so the policy expression no
-- longer names a table.
--
-- What changes is the shape. `uoa_org_domain(org_id)` handed `uoa_app` another
-- tenant's domain for any id; `uoa_org_owner_id(org_id)` handed it another
-- tenant's owner id. Both are only ever compared against a value the policy
-- already has, so a boolean predicate is a drop-in replacement that answers
-- "is it this?" instead of "what is it?" — an attacker who reaches `uoa_app`
-- must now already know the answer to learn nothing new.

CREATE OR REPLACE FUNCTION uoa_org_in_domain(p_org_id text, p_domain text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT EXISTS (
    SELECT 1 FROM organisations o
    WHERE o.id = p_org_id AND o.domain = p_domain
  )
$$;

CREATE OR REPLACE FUNCTION uoa_org_is_owned_by(p_org_id text, p_user_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT EXISTS (
    SELECT 1 FROM organisations o
    WHERE o.id = p_org_id AND o.owner_id = p_user_id
  )
$$;

-- Keeps `org_members.domain` (section 4) derived rather than supplied. SECURITY
-- DEFINER for the same reason as the predicates: it must see the organisation
-- row whatever the caller can see.
CREATE OR REPLACE FUNCTION uoa_org_members_sync_domain()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  SELECT o.domain INTO NEW.domain
  FROM organisations o
  WHERE o.id = NEW.org_id;
  RETURN NEW;
END;
$$;

-- An organisation's domain is never updated by any code path today, so the
-- denormalised copy cannot drift. "Today" is not an invariant, so make it one:
-- if a domain ever does change, the copies follow it, and any membership the
-- move would collide with fails on the unique index rather than going stale.
CREATE OR REPLACE FUNCTION uoa_organisations_cascade_domain()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE org_members SET domain = NEW.domain WHERE org_id = NEW.id;
  RETURN NULL;
END;
$$;

-- `current_schema()` is the schema the CREATE FUNCTION statements above wrote
-- into (the isolated schema under test, `public` in production), so pinning
-- through it cannot pick up a same-named function in another schema.
DO $$
DECLARE
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'uoa_org_in_domain(text, text)',
    'uoa_org_is_owned_by(text, text)',
    'uoa_org_members_sync_domain()',
    'uoa_organisations_cascade_domain()'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %I.%s SET search_path = %I, pg_temp', current_schema(), fn, current_schema());
    -- Definer rights are not for anonymous callers. 20260730120000 revoked this
    -- for the two accessors but not for its trigger function; every function
    -- created here gets the same treatment.
    EXECUTE format('REVOKE ALL ON FUNCTION %I.%s FROM PUBLIC', current_schema(), fn);
  END LOOP;

  -- The roles are created by 20260423000000_rls_roles_and_grants, which every
  -- environment replays before reaching this file, so they are always present.
  -- Guarded anyway: a GRANT to a missing role aborts the whole migration, and
  -- the cost of not finding out that way is one `pg_roles` lookup.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uoa_app') THEN
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.uoa_org_in_domain(text, text), %I.uoa_org_is_owned_by(text, text) TO uoa_app',
      current_schema(), current_schema()
    );
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uoa_admin') THEN
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.uoa_org_in_domain(text, text), %I.uoa_org_is_owned_by(text, text) TO uoa_admin',
      current_schema(), current_schema()
    );
  END IF;
END
$$;

-- =====================================================================
-- 3. Repoint the policies at the narrowed predicates.
-- =====================================================================
-- Same predicates, same truth values — only the function shape changes.

DROP POLICY IF EXISTS access_requests_select ON "access_requests";
DROP POLICY IF EXISTS access_requests_insert ON "access_requests";
DROP POLICY IF EXISTS access_requests_update ON "access_requests";
DROP POLICY IF EXISTS access_requests_delete ON "access_requests";

CREATE POLICY access_requests_select ON "access_requests"
  FOR SELECT TO uoa_app
  USING (
    org_id = NULLIF(current_setting('app.org_id', true), '')
    AND uoa_org_in_domain(org_id, NULLIF(current_setting('app.domain', true), ''))
  );

CREATE POLICY access_requests_insert ON "access_requests"
  FOR INSERT TO uoa_app
  WITH CHECK (
    org_id = NULLIF(current_setting('app.org_id', true), '')
    AND uoa_org_in_domain(org_id, NULLIF(current_setting('app.domain', true), ''))
  );

CREATE POLICY access_requests_update ON "access_requests"
  FOR UPDATE TO uoa_app
  USING (
    org_id = NULLIF(current_setting('app.org_id', true), '')
    AND uoa_org_in_domain(org_id, NULLIF(current_setting('app.domain', true), ''))
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.org_id', true), '')
    AND uoa_org_in_domain(org_id, NULLIF(current_setting('app.domain', true), ''))
  );

CREATE POLICY access_requests_delete ON "access_requests"
  FOR DELETE TO uoa_app
  USING (
    org_id = NULLIF(current_setting('app.org_id', true), '')
    AND uoa_org_in_domain(org_id, NULLIF(current_setting('app.domain', true), ''))
  );

DROP POLICY IF EXISTS org_members_select ON "org_members";

CREATE POLICY org_members_select ON "org_members"
  FOR SELECT TO uoa_app
  USING (
    org_id = NULLIF(current_setting('app.org_id', true), '')
    -- Bootstrap: the caller owns this organisation. Identical in effect to the
    -- branch teams_select and team_members_select already carry, and required
    -- for `INSERT ... RETURNING` during organisation creation, when the org
    -- exists but `app.org_id` does not yet name it.
    OR uoa_org_is_owned_by(org_id, NULLIF(current_setting('app.user_id', true), ''))
    -- The domain's own backend sees membership across its own domain. Gated on
    -- app.domain_backend, which only `requireOrgRole` / `requireOrgBackendOnly`
    -- can cause to be set, so a signed-in user never reaches this branch.
    OR (
      NULLIF(current_setting('app.domain_backend', true), '') = 'on'
      AND uoa_org_in_domain(org_id, NULLIF(current_setting('app.domain', true), ''))
    )
  );

DROP FUNCTION IF EXISTS uoa_org_domain(text);
DROP FUNCTION IF EXISTS uoa_org_owner_id(text);

-- =====================================================================
-- 4. The invariant, as an actual constraint.
-- =====================================================================
--
-- A unique index cannot reference another table, so the domain has to be on the
-- row. `org_members.domain` is a derived copy of `organisations.domain`: the
-- trigger below sets it on every INSERT and on any UPDATE that moves the row to
-- another organisation, and the cascade trigger follows a domain rename. It is
-- never written by application code — the DEFAULT exists only so Prisma can omit
-- the column from its INSERTs, and the trigger overwrites whatever arrives.

ALTER TABLE "org_members" ADD COLUMN IF NOT EXISTS "domain" text NOT NULL DEFAULT '';

DROP TRIGGER IF EXISTS org_members_sync_domain ON "org_members";
CREATE TRIGGER org_members_sync_domain
  BEFORE INSERT OR UPDATE OF org_id ON "org_members"
  FOR EACH ROW
  EXECUTE FUNCTION uoa_org_members_sync_domain();

DROP TRIGGER IF EXISTS organisations_cascade_domain ON "organisations";
CREATE TRIGGER organisations_cascade_domain
  AFTER UPDATE OF domain ON "organisations"
  FOR EACH ROW
  WHEN (NEW.domain IS DISTINCT FROM OLD.domain)
  EXECUTE FUNCTION uoa_organisations_cascade_domain();

UPDATE "org_members" om
SET domain = o.domain
FROM "organisations" o
WHERE o.id = om.org_id AND om.domain IS DISTINCT FROM o.domain;

-- The name the failed trigger used to invent. It now exists, so a violation
-- surfaces as a 23505 naming a real object and Prisma's P2002 carries a real
-- target.
CREATE UNIQUE INDEX IF NOT EXISTS "org_members_one_active_org_per_domain"
  ON "org_members" ("user_id", "domain")
  WHERE "status" = 'ACTIVE';

-- The check-then-write trigger it replaces. Dropped last so the table is never
-- unprotected mid-transaction.
DROP TRIGGER IF EXISTS org_members_single_active_org_per_domain ON "org_members";
DROP FUNCTION IF EXISTS uoa_assert_single_active_org_per_domain();
