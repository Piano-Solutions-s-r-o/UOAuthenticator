-- Tenant isolation and bootstrap-visibility fixes for `/org/*`, all of which
-- only exist under the production RLS roles (uoa_app / uoa_admin).
--
-- Four independent problems, all in the policies created by
-- 20260423000001_rls_enable_policies:
--
--   1. access_requests keyed on `app.org_id` alone. The access-request routes
--      populate that GUC from the raw path `:orgId`, and the only other check
--      compared the path ids against ids supplied by the CALLER'S OWN signed
--      config. A domain could therefore sign a valid config naming another
--      tenant's org/team, call with its own bearer and `?domain=`, and read and
--      reject that tenant's access requests. The service layer now resolves the
--      org by (id, domain); this makes the policy agree, so neither layer is
--      load-bearing alone.
--
--   2. organisations_select had no branch a domain BACKEND could satisfy, so
--      `GET /org/organisations` — a deliberately backend-to-backend route with
--      neither `app.org_id` nor `app.user_id` — returned zero rows in
--      production while appearing to work in every superuser-backed test.
--
--   3. org_members_select was the ONLY tenant-scoped select policy without the
--      "the caller owns this organisation" bootstrap branch that teams_select
--      and team_members_select both carry. Organisation creation sets
--      `app.org_id` empty (the org does not exist yet), so the owner's
--      `INSERT ... RETURNING` on org_members failed the SELECT policy and
--      `POST /org/organisations` errored for BOTH user and backend callers.
--
--   4. The documented one-organisation-per-user-per-domain invariant was
--      enforced only by service-layer probes that RLS blinds: org_members is
--      visible only within `app.org_id`, so a probe for "is this user already
--      active in a SIBLING org on this domain?" could never see one.
--
-- `app.domain_backend` is a new GUC set by runWithTenantContext, and only ever
-- from `request.orgBackendCaller` — which `requireOrgRole` is the sole writer
-- of, and only when it accepted a call on the domain pairing alone. A
-- signed-in user never sets it, so the domain-wide branches below cannot widen
-- what any user can see.
--
-- Rollback: restore the four policy definitions from
-- 20260423000001_rls_enable_policies, then drop the trigger and the three
-- functions created here.

-- =====================================================================
-- 0. Organisation accessors used by the policies below.
-- =====================================================================
--
-- `organisations_select` already subqueries `org_members`. Any policy on
-- `org_members` (or on a table whose policy reaches `organisations`) that
-- subqueries `organisations` back closes a policy cycle, and PostgreSQL refuses
-- the plan with 42P17 "infinite recursion detected in policy for relation".
--
-- These STABLE SECURITY DEFINER accessors break the cycle: their bodies run as
-- the definer, so they are not themselves RLS-expanded and the calling policy
-- expression no longer names a table at all. They expose strictly less than the
-- policies calling them — an organisation's domain or owner id, for an id the
-- caller already holds.

CREATE OR REPLACE FUNCTION uoa_org_domain(p_org_id text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$ SELECT o.domain FROM organisations o WHERE o.id = p_org_id $$;

CREATE OR REPLACE FUNCTION uoa_org_owner_id(p_org_id text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$ SELECT o.owner_id FROM organisations o WHERE o.id = p_org_id $$;

-- `current_schema()` is the schema the CREATE FUNCTION statements above wrote
-- into (the isolated schema under test, `public` in production), so pinning
-- through it cannot pick up a same-named function in another schema.
DO $$
BEGIN
  EXECUTE format(
    'ALTER FUNCTION %I.uoa_org_domain(text) SET search_path = %I, pg_temp',
    current_schema(), current_schema()
  );
  EXECUTE format(
    'ALTER FUNCTION %I.uoa_org_owner_id(text) SET search_path = %I, pg_temp',
    current_schema(), current_schema()
  );
  -- Definer rights are not for anonymous callers.
  EXECUTE format('REVOKE ALL ON FUNCTION %I.uoa_org_domain(text) FROM PUBLIC', current_schema());
  EXECUTE format('REVOKE ALL ON FUNCTION %I.uoa_org_owner_id(text) FROM PUBLIC', current_schema());
  EXECUTE format(
    'GRANT EXECUTE ON FUNCTION %I.uoa_org_domain(text) TO uoa_app, uoa_admin',
    current_schema()
  );
  EXECUTE format(
    'GRANT EXECUTE ON FUNCTION %I.uoa_org_owner_id(text) TO uoa_app, uoa_admin',
    current_schema()
  );
END
$$;

-- =====================================================================
-- 1. access_requests — bind every policy to the calling domain.
-- =====================================================================

DROP POLICY IF EXISTS access_requests_select ON "access_requests";
DROP POLICY IF EXISTS access_requests_insert ON "access_requests";
DROP POLICY IF EXISTS access_requests_update ON "access_requests";
DROP POLICY IF EXISTS access_requests_delete ON "access_requests";

CREATE POLICY access_requests_select ON "access_requests"
  FOR SELECT TO uoa_app
  USING (
    org_id = NULLIF(current_setting('app.org_id', true), '')
    AND uoa_org_domain(org_id) = NULLIF(current_setting('app.domain', true), '')
  );

CREATE POLICY access_requests_insert ON "access_requests"
  FOR INSERT TO uoa_app
  WITH CHECK (
    org_id = NULLIF(current_setting('app.org_id', true), '')
    AND uoa_org_domain(org_id) = NULLIF(current_setting('app.domain', true), '')
  );

CREATE POLICY access_requests_update ON "access_requests"
  FOR UPDATE TO uoa_app
  USING (
    org_id = NULLIF(current_setting('app.org_id', true), '')
    AND uoa_org_domain(org_id) = NULLIF(current_setting('app.domain', true), '')
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.org_id', true), '')
    AND uoa_org_domain(org_id) = NULLIF(current_setting('app.domain', true), '')
  );

CREATE POLICY access_requests_delete ON "access_requests"
  FOR DELETE TO uoa_app
  USING (
    org_id = NULLIF(current_setting('app.org_id', true), '')
    AND uoa_org_domain(org_id) = NULLIF(current_setting('app.domain', true), '')
  );

-- =====================================================================
-- 2. organisations_select — a branch the domain backend can satisfy.
-- =====================================================================

DROP POLICY IF EXISTS organisations_select ON "organisations";

CREATE POLICY organisations_select ON "organisations"
  FOR SELECT TO uoa_app
  USING (
    id = NULLIF(current_setting('app.org_id', true), '')
    OR owner_id = NULLIF(current_setting('app.user_id', true), '')
    OR (
      domain = NULLIF(current_setting('app.domain', true), '')
      AND EXISTS (
        SELECT 1 FROM "org_members" om
        WHERE om.org_id = organisations.id
          AND om.user_id = NULLIF(current_setting('app.user_id', true), '')
      )
    )
    -- The domain's own backend sees the domain's own organisations. Gated on
    -- app.domain_backend so a user-mode request keeps exactly the visibility it
    -- had before: the three branches above and nothing more.
    OR (
      domain = NULLIF(current_setting('app.domain', true), '')
      AND NULLIF(current_setting('app.domain_backend', true), '') = 'on'
    )
  );

-- =====================================================================
-- 3. org_members_select — restore the bootstrap branch its sibling tables
--    already have, and let the domain backend see its own domain.
-- =====================================================================

DROP POLICY IF EXISTS org_members_select ON "org_members";

CREATE POLICY org_members_select ON "org_members"
  FOR SELECT TO uoa_app
  USING (
    org_id = NULLIF(current_setting('app.org_id', true), '')
    -- Bootstrap: the caller owns this organisation. Identical in effect to the
    -- branch teams_select and team_members_select already carry, and required
    -- for `INSERT ... RETURNING` during organisation creation, when the org
    -- exists but `app.org_id` does not yet name it.
    OR uoa_org_owner_id(org_id) = NULLIF(current_setting('app.user_id', true), '')
    -- The domain's own backend sees membership across its own domain, which is
    -- what the one-org-per-user-per-domain probes need. Never set in user mode.
    OR (
      NULLIF(current_setting('app.domain_backend', true), '') = 'on'
      AND uoa_org_domain(org_id) = NULLIF(current_setting('app.domain', true), '')
    )
  );

-- =====================================================================
-- 4. One ACTIVE organisation membership per user per domain, enforced in
--    the database.
-- =====================================================================
--
-- The invariant is documented in Docs/brief.md and was previously enforced only
-- by service-layer probes. Those probes read through the tenant role, so RLS
-- hides exactly the rows they are looking for, and they are also a
-- check-then-write race. A trigger is neither: it runs on every write path —
-- user mode, backend mode, and any future one — and it sees the committed state
-- at write time.
--
-- SECURITY DEFINER for the same reason as the accessors above: the whole point
-- is to see sibling rows the caller cannot.

CREATE OR REPLACE FUNCTION uoa_assert_single_active_org_per_domain()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  member_domain text;
  conflicting_org text;
BEGIN
  -- Tombstones (DEACTIVATED / REMOVED) are not memberships; only a write that
  -- produces an ACTIVE row can create a violation.
  IF NEW.status IS DISTINCT FROM 'ACTIVE' THEN
    RETURN NEW;
  END IF;

  SELECT o.domain INTO member_domain
  FROM organisations o
  WHERE o.id = NEW.org_id;

  IF member_domain IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT om.org_id INTO conflicting_org
  FROM org_members om
  JOIN organisations o2 ON o2.id = om.org_id
  WHERE om.user_id = NEW.user_id
    AND om.status = 'ACTIVE'
    AND om.org_id <> NEW.org_id
    AND o2.domain = member_domain
  LIMIT 1;

  IF conflicting_org IS NOT NULL THEN
    RAISE EXCEPTION
      'user already holds an active organisation membership on this domain'
      USING ERRCODE = '23505',
            CONSTRAINT = 'org_members_one_active_org_per_domain';
  END IF;

  RETURN NEW;
END;
$$;

DO $$
BEGIN
  EXECUTE format(
    'ALTER FUNCTION %I.uoa_assert_single_active_org_per_domain() SET search_path = %I, pg_temp',
    current_schema(), current_schema()
  );
END
$$;

DROP TRIGGER IF EXISTS org_members_single_active_org_per_domain ON "org_members";

CREATE TRIGGER org_members_single_active_org_per_domain
  BEFORE INSERT OR UPDATE OF org_id, user_id, status ON "org_members"
  FOR EACH ROW
  EXECUTE FUNCTION uoa_assert_single_active_org_per_domain();
