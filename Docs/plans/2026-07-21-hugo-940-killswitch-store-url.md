# HUGO-940 — Kill-switch update CTA: App Store URI vs. custom URL

Jira: HUGO-940. Related: HUGO-862 / HUGO-873 (POS banner) / HUGO-874.
Spans TWO repos: **UOA fork** (`UnlikeOtherAuthenticator`, admin + API) and **Hugo POS** (Flutter app).
Status: planning (pre-review).

## Goal
Let a UOA admin pick, per kill-switch rule, where the app's **Update** CTA leads:
**App Store / Play (default)** or a **custom URL** (e.g. a TestFlight join link
`https://testflight.apple.com/join/Ym6jXbkA` during closed testing). Data-driven —
changeable in UOA with no new app build; works for TestFlight now and the App Store later.

## Current state (from end-to-end recon)
**UOA fork — half wired already:**
- ✅ DB: `kill_switch_entries.store_url TEXT NULL` already exists (`schema.prisma:445`,
  migration `20260423093000`). **No migration needed.** App-level default `apps.store_url`
  also exists (`schema.prisma:413`).
- ✅ Startup emit: `app-startup.service.ts:194` already returns
  `storeUrl: entry.storeUrl ?? app.storeUrl` (camelCase). **No emit change needed.**
- ❌ Admin create/update path drops `store_url` at EVERY layer: server zod
  `KillSwitchSchema` (`routes/internal/admin/apps.ts:45-59`), `toKillSwitchInput`
  (`apps.ts:141-156`), `AdminKillSwitchInput` (`internal-admin.service.apps.ts:197-210`),
  `toKillSwitchData` (`…apps.ts:225-250`).
- ❌ Read mapping for edit-prefill omits it (`internal-admin.service.base.ts:182-198`).
- ❌ Admin types (`features/admin/types.ts:214-230`, `services/admin-service.ts:265-278`),
  form zod (`schemas/admin.ts:47-60`), and the dialog (`KillSwitchDialog.tsx`) have no field.

**Hugo POS — does not honor it at all:**
- `AppKillSwitch.fromJson` never reads `storeUrl` (`lib/data/app_kill_switch.dart`).
- Both CTAs (`kill_switch_notice_banner.dart` soft, `update_required_screen.dart` hard)
  call the shared `appStoreUri()` (`lib/data/app_store_url.dart`) directly.

## Design decisions (v2 — after dual read-only review; both reviewers converged)
1. **Semantics (no emit change):** "App Store default" = store `entry.storeUrl = NULL`
   → existing `entry.storeUrl ?? app.storeUrl` fallback → the POS resolves the platform store.
   "Custom URL" = store the provided https URL on the entry.
   - **Precondition made hard (review finding #2):** this only means "platform store" if the
     Hugo **app-level** `apps.store_url` is NULL. Evidence it is: the staging soft rule already
     emits `storeUrl: null` (entry null → `?? app.storeUrl` → null), AND there is **no code path
     that ever sets `apps.store_url`** (`CreateAppSchema` has no `store_url`; no app PATCH route).
     So it is structurally NULL. **Rollout adds a hard pre-flight SQL check** on staging AND prod:
     `SELECT identifier, store_url FROM apps WHERE identifier ILIKE '%hugo%';` must be NULL. If a
     value ever exists, clear it (or "default" would emit it and the POS would honor it).
2. **UI — SINGLE optional field (simpler; review finding #6):** in `KillSwitchDialog` add ONE
   optional text field **"Update URL (optional)"** with helper *"Leave empty to use the App Store /
   Google Play. Used by the Update button on soft/hard rules."* Empty ⇒ `store_url: null` (default);
   a value ⇒ custom. **Rationale:** the dialog is entirely flat `TextField`/`SelectField` rows with
   NO radio/conditional-visibility control today; a radio + react-hook-form `watch` + conditional
   input + mode-prefill is more surface than "empty = default" needs. A single field is the choice
   (empty vs filled), matches the form idiom, and honors the "keep it simple / no over-engineering"
   standard. (Both the store-default and the custom URL are reachable — the user's "either/or" is
   satisfied by empty-vs-filled with explicit helper copy.)
   - Field shown for all types; the helper states it only affects soft/hard (the CTA-bearing types).
     No `watch`-based hiding — keeps the dialog flat. info/maintenance simply ignore it (POS renders
     no CTA for them).
3. **Validation (both ends, robust — review finding #4):** custom URL must be an absolute **https**
   URL, max 2048. Server zod: `z.string().url().max(2048).refine(v => { try { return new
   URL(v).protocol === 'https:'; } catch { return false; } }).nullable().optional()` — parse-based,
   NOT `startsWith('https://')`. Client `KillSwitchFormSchema` mirrors it (empty string coerced to
   null before submit). No existing app.storeUrl validation convention exists — this establishes it.
4. **POS honoring (one resolver, both CTAs — review finding #5):** add `storeUrl` to
   `AppKillSwitch` (parse + cache round-trip). Add `Uri storeUriFor(AppKillSwitch ks)` returning
   `ks.storeUrl` **only if** `Uri.tryParse` yields a non-null Uri with `isScheme('https') &&
   host.isNotEmpty`, else `appStoreUri()`. Both the soft banner and hard-block screen call the
   resolver — preserves the HUGO-862 "one source of truth" contract. The **resolver** is the guard
   (not `_openStore`), so a bad URL can never reach `launchUrl` and the banner never becomes a dead
   CTA. Use `Uri.tryParse` (Dart's `Uri.parse` is lenient and won't throw on junk).

## Changes

### A. UOA fork (`hugo-940-killswitch-store-url` branch)
1. **API zod** `KillSwitchSchema` (`routes/internal/admin/apps.ts:45`): add the parse-based
   https `store_url` field (see decision 3). Schema is `.strict()`, so this is required to accept it.
2. `toKillSwitchInput` (`apps.ts:141`): pass `storeUrl: body.store_url ?? null`.
3. `AdminKillSwitchInput` (`internal-admin.service.apps.ts:197`): add `storeUrl?: string | null`.
4. `toKillSwitchData` (`…apps.ts:225`): set `storeUrl: input.storeUrl ?? null` (null = default;
   the returned object is spread into `prisma.killSwitchEntry.create/update`, so this writes it).
5. Read mapping `internal-admin.service.base.ts:182`: add `storeUrl: entry.storeUrl` to the
   `killSwitches.map` so the edit dialog prefills.
6. **`/api` contract schema (review finding #3 — repo rule):** add `store_url` to the POST/PATCH
   kill-switch body schemas in `routes/root/schema.internal-admin-apps.ts:75,95`. Check whether
   the `/llm` recipe (`routes/root/llm-integration.ts`) enumerates kill-switch fields; if so, add it.
7. **Admin types**: `KillSwitchEntry` (`features/admin/types.ts:214`) + `KillSwitchInput`
   (`services/admin-service.ts:265`) gain `storeUrl?: string | null`.
8. **Admin form zod** `KillSwitchFormSchema` (`schemas/admin.ts:47`): `storeUrl` optional https URL
   (empty string → null via transform).
9. **Dialog** `KillSwitchDialog.tsx`: add ONE optional "Update URL" `FieldShell`/`TextField`
   (decision 2); wire `defaultValues()` (`:152`, prefill from `storeUrl`) and `submit()` (`:42`,
   `store_url: url.trim() || null`); include `store_url` in `toKillSwitchBody` (`admin-service.ts:280`).
10. **Tests**: API — new route/validation test (accepts https, rejects http/malformed/non-URL,
    empty⇒null); emit — extend `app-startup.service.test.ts` with an "entry.storeUrl overrides
    app.storeUrl" + "entry null falls back to app.storeUrl" assertion. Admin — a `KillSwitchDialog`
    test: field prefills from `storeUrl`, empty submits null, a URL submits through.
11. **Docs**: `Docs/Requirements/apps.md` (~:150) — document the admin optional-URL control.

### B. Hugo POS (branch `fix/hugo-940-pos-store-url`, based on the HUGO-873 branch — see Impact)
1. `app_kill_switch.dart`: `final String? storeUrl;` + constructor + `fromJson`
   `str('storeUrl','store_url')` + `toJson` `'store_url'` (cache round-trip).
2. `app_store_url.dart`: add `Uri storeUriFor(AppKillSwitch ks)` → `Uri.tryParse(ks.storeUrl)`
   with `isScheme('https') && host.isNotEmpty` else `appStoreUri()`.
3. `kill_switch_notice_banner.dart` `_openStore` + `update_required_screen.dart` `_openStore`:
   launch `storeUriFor(killSwitch)`.
4. **Tests**: model parse + `store_url` round-trip (`app_kill_switch_test.dart`); **resolver
   function-level tests** (`app_store_url_test.dart` — https honored; http/empty/hostless/junk fall
   back to `appStoreUri()`); widget tests (url_launcher mock) that the launched URI is the custom
   one for a soft/hard rule with storeUrl, and the store otherwise.
5. **No Hugo-API change:** `API/src/routes/app_startup.js:117-120` returns UOA's payload verbatim,
   so `storeUrl` already reaches the POS — nothing to change server-side in Hugo.

## Impact on previous / adjacent work (checked)
- **HUGO-873 (PR #373, open):** modifies the SAME banner file (`kill_switch_notice_banner.dart`)
  — the dismiss IconButton, not `_openStore`. The POS part of HUGO-940 edits `_openStore`.
  Different lines but same file ⇒ base the POS branch on `fix/hugo-862-banner-overlay-crash`
  (or land #373 first). Do NOT double-touch. Flagged so the two don't collide.
- **HUGO-874 (PR #374, open):** staging appIdentifier. Independent, but the staging E2E of
  HUGO-940 relies on staging resolving the staging UOA app — either #374 merged+applied, or the
  temporary `VOICEPOS_APP_IDENTIFIER` dart-define during manual testing. Note only; no code overlap.
- **HUGO-862 (merged):** the "one source of truth" store-URL contract — the resolver must stay
  shared by both CTAs; the plan keeps that.
- **Emit fallback (`entry.storeUrl ?? app.storeUrl`):** unchanged; existing startup tests must
  stay green (`app-startup.service.test.ts` uses partial `toMatchObject`, doesn't assert storeUrl —
  our new assertion is additive). No other consumer of `storeUrl` found.
- **No DB migration**, so no PRE_DEPLOY/migration risk.
- **i18n — none needed (state explicitly):** (a) the UOA Admin is NOT internationalized — every
  `KillSwitchDialog` label is hardcoded English, so a plain-English "Update URL" field is consistent
  and the Hugo-Admin i18n mandate does not apply to this fork; (b) the POS adds NO new user-facing
  string (CTA label stays the existing `killSwitch.updateAction`). So no key changes anywhere.
- **Security:** the setter is gated by `requireAdminApiKeyOrSuperuser` (`apps.ts:123`); the POS
  enforces https + store fallback. Residual risk (an admin pointing the CTA at an https phishing
  page) is inherent to any admin-controlled deep link — acceptable, noted.

## Rollout
- **Pre-flight (hard gate, review finding #2):** on staging AND prod UOA DB run
  `SELECT identifier, store_url FROM apps WHERE identifier ILIKE '%hugo%';` and confirm `store_url`
  is NULL for both `com.piano.hugo` and `com.piano.hugo.staging`. If non-null, clear it — otherwise
  "default" (entry NULL) would emit the app URL and the POS would honor it instead of the store.
- UOA fork: merge to the **Piano fork** (`piano/main`, deploys sso.hugopos.eu) — out-of-band
  deploy per the fork's process (not this repo's CI). POS: ships in the next app build.
- **Verify on staging:** set a Custom URL (`https://testflight.apple.com/join/Ym6jXbkA`) on the
  staging soft rule via the new dialog → POS Update button opens it; clear it (default) → opens
  the store. Screenshot both.

## Non-goals
- No change to the emit logic, DB schema, or app-level `apps.store_url`.
- No new kill-switch types; no change to hard/maintenance gating.
- Not touching the App Store listing id (`_iosAppStoreId`) — separate concern.
