# HUGO-947 fork-sync — deploy runbook (rehearse-first)

Executes the rollout for the merged sync branch `hugo-947-fork-sync` (backed up on
`piano/hugo-947-fork-sync`) onto the LIVE SSO `sso.hugopos.eu` (DO App Platform app
`hugo-sso`, id `3a774a9f-9eba-480e-937a-948d333aeecf`).

**Verified locally already:** merge resolved (0 markers), full typecheck ✓, full
`pnpm -r build` ✓, full test suite **1370 pass / 0 fail**. (`docker build` was
attempted but hit a local docker-daemon disk I/O error — infra, not code; the
prod image builds in CI via the same Dockerfile the pnpm build already exercised.)

**Non-negotiables:** never `git push piano main` / deploy prod without a green
rehearsal + review (do-not-self-merge, live auth). Migrations run **on container
boot** (`Dockerfile:72 → docker/start-production.sh` → `prisma migrate deploy`), so
a bad migration = **login lockout** → rehearse first. Prod-auth secrets (DB creds,
`SHARED_SECRET`, RS256 keys, Apple/SendGrid keys) must be handled by the operator,
never pasted into shared logs.

---

## 0. Env-var delta (set on `hugo-sso` BEFORE deploy)
Upstream adds billing/signature runtime config. Ship them **disabled** so the sync
delivers the Teams/exchange work without turning billing on:
- `STRIPE_BILLING_ENABLED=false`
- signature storage / GCS invoice storage **disabled** (leave the new GCS/Stripe
  vars unset or explicitly disabled — see `API/src/config/env.ts` for the new keys;
  the deploy-main workflow test that enumerated them was removed as fork-irrelevant).
- Keep all existing Piano secrets (SendGrid, Apple, DO DB, config JWT keys, SHARED_SECRET).
- New workspace pkg `@unlikeotherai/billing-statement-protocol` is bundled by the
  Docker build (workspace:* dep) — no env needed.

## 1. Migration rehearsal (operator runs; against a CLONE, never prod)
Create a throwaway clone/snapshot of the prod SSO Postgres (DO console →
Databases → the SSO DB → Fork / or restore a snapshot to a temp DB). Then:
```
# from the sync worktree, against the CLONE connection string:
DATABASE_URL='postgresql://<clone-creds>@<clone-host>:25060/<db>?sslmode=require' \
  pnpm --filter @uoa/api exec prisma migrate deploy
```
Expected: applies the 35 new migrations cleanly. **Watch specifically:**
- `20260616000000_add_bans` — earlier timestamp than the already-applied
  `20260630120000_admin_api_keys`; confirm the out-of-order apply succeeds.
- `20260719060000_harden_stripe_account_and_subscription_lifecycle` — fails if the
  new Stripe projection tables already hold rows; on Piano they're created empty by
  the prior migration → should pass. Verify.
If any migration errors → STOP; do not deploy (would lock out login on boot).

## 2. Smoke the merged image against the clone (operator runs, local)
```
docker build -t uoa-sync:rehearse .
docker run --rm -p 8080:8080 --env-file <sso-env-with-CLONE-db> uoa-sync:rehearse
# in another shell:
curl -fsS localhost:8080/health
```
Smoke checklist (the fork-preserved behaviours + the new exchange):
- `GET /health` 200; `/admin` shell loads.
- **Sign in with Apple** (HUGO-570): `GET /.well-known/apple-developer-domain-association.txt` served; Apple POST callback parses.
- **cs registration email locale** (HUGO-626/553).
- **Killswitch `store_url`** (HUGO-940): create a kill-switch with `store_url` → forwarded.
- **Normal SSO login** end-to-end.
- **Confidential token-exchange present**: `POST /auth/token` with `grant_type=urn:ietf:params:oauth:grant-type:token-exchange` returns a structured error (not 404) → the new exchange route is live (this is what unblocks the team-mirror Phase 1).

## 3. Fresh adversarial review of the RESOLVED merge
Codex + Claude review the merge diff (`git diff piano/main...hugo-947-fork-sync`)
one more time before prod — focus on the 9 hand-combined auth-critical files.

## 4. Prod deploy (operator + sign-off; do-not-self-merge)
Two equivalent options — either triggers the on-boot migrations:
- **A (via git, preferred, auditable):** open a PR `piano/main ← hugo-947-fork-sync`,
  review, merge → `deploy-do.yml` builds+pushes the image to DOCR and
  `doctl apps create-deployment hugo-sso --wait`.
- **B (manual):** `doctl registry login`; `docker buildx build --platform linux/amd64
  -t registry.digitalocean.com/hugopos/hugo-sso:<sha> --push .`; then
  `doctl apps create-deployment 3a774a9f-9eba-480e-937a-948d333aeecf --wait`.
Watch the deploy logs for `prisma migrate deploy` success on boot.

## 5. Post-deploy verification
Repeat the §2 smoke against `https://sso.hugopos.eu` (login, Apple, cs email,
killswitch). Confirm existing Hugo Admin/POS login still works.

## 6. Rollback (rehearse the trigger, keep it one command away)
- **App:** redeploy the **previous image SHA** (not `latest`):
  `doctl apps create-deployment <appId>` after re-pointing to the prior tag, or roll
  back in the DO console to the previous deployment.
- **DB:** migrations are additive → old code tolerates the new schema; if a migration
  locks boot, roll the app back immediately and forward-fix. True DB rollback = the
  managed-Postgres snapshot/PITR taken before step 4.

## After the sync is live → Phase 1 (team-mirror)
Implement the confidential `token.provision` guard per
`Docs/plans/2026-07-22-uoa-team-mirror-confidential-provision.md` §Phase 1
(now testable against the deployed exchange), then Phase 2 (Hugo wiring).
