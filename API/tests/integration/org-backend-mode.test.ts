// End-to-end proof of `/org/*` backend mode against real routes and a real
// database: a product backend drives the org graph with the domain pairing
// alone (domain-hash bearer + verified signed config + `?domain=`) and NO
// `X-UOA-Access-Token`.
//
// The mocked-middleware unit suite proves the guard's decisions; this proves the
// whole chain — routes, services, RLS transactions, and the audit trail — works
// with no acting user, and that the tenant boundary holds.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';
import { ORG_AUDIT_ACTOR_METADATA_KEY } from '../../src/services/org-audit-log.service.js';
import { seedDomainSecret } from '../helpers/domain-secret.js';
import { createTestDb } from '../helpers/test-db.js';
import {
  clearOrgTestDatabase,
  createSignedConfigJwt,
  createTestUser,
  hasDatabase,
  signAccessToken,
  type OrgMemberRecord,
  type OrgRecord,
  type TeamRecord,
  type TeamWithMembersRecord,
} from '../helpers/org-user-endpoints-helper.js';

const BACKEND_DOMAIN = 'backend-mode.example.com';
const BACKEND_CONFIG_URL = `https://${BACKEND_DOMAIN}/auth-config`;
const OTHER_DOMAIN = 'other-tenant.example.com';
const OTHER_CONFIG_URL = `https://${OTHER_DOMAIN}/auth-config`;

describe.skipIf(!hasDatabase)('/org/* backend mode (domain pairing, no user token)', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;

  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalSharedSecret = process.env.SHARED_SECRET;
  const originalAud = process.env.AUTH_SERVICE_IDENTIFIER;

  beforeAll(async () => {
    handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for DB-backed tests');
    process.env.DATABASE_URL = handle.databaseUrl;
  });

  afterAll(async () => {
    process.env.DATABASE_URL = originalDatabaseUrl;
    process.env.SHARED_SECRET = originalSharedSecret;
    process.env.AUTH_SERVICE_IDENTIFIER = originalAud;
    if (handle) await handle.cleanup();
  });

  beforeEach(async () => {
    process.env.SHARED_SECRET =
      process.env.SHARED_SECRET ?? 'test-shared-secret-with-enough-length';
    process.env.AUTH_SERVICE_IDENTIFIER = process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';
    if (!handle) return;
    await handle.prisma.domainRole.deleteMany();
    await clearOrgTestDatabase(handle);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /**
   * Serve each domain its own signed config from the same stubbed fetch, so a
   * single app instance can be driven as two different tenants.
   */
  async function stubConfigs(opts: {
    backendOrgManagement: boolean;
    otherBackendOrgManagement?: boolean;
  }): Promise<void> {
    const backendJwt = await createSignedConfigJwt(
      process.env.SHARED_SECRET!,
      { backend_org_management: opts.backendOrgManagement },
      BACKEND_DOMAIN,
    );
    const otherJwt = await createSignedConfigJwt(
      process.env.SHARED_SECRET!,
      { backend_org_management: opts.otherBackendOrgManagement ?? true },
      OTHER_DOMAIN,
    );

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes(OTHER_DOMAIN)) return new Response(otherJwt, { status: 200 });
        return new Response(backendJwt, { status: 200 });
      }),
    );
  }

  function url(path: string, domain = BACKEND_DOMAIN, configUrl = BACKEND_CONFIG_URL): string {
    const sep = path.includes('?') ? '&' : '?';
    return `${path}${sep}domain=${encodeURIComponent(domain)}&config_url=${encodeURIComponent(configUrl)}`;
  }

  /**
   * A user who belongs to a domain — the user row plus the `DomainRole` that
   * login writes (`ensureDomainRoleForUser`). Backend mode requires it before
   * it will accept an id as `owner_user_id`, because plain existence is not a
   * tenant boundary under the default global `user_scope`.
   */
  async function createDomainUser(email: string, domain = BACKEND_DOMAIN) {
    const user = await createTestUser(handle!, email);
    await handle!.prisma.domainRole.create({ data: { domain, userId: user.id } });
    return user;
  }

  it('drives the whole organisation lifecycle with no X-UOA-Access-Token', async () => {
    await stubConfigs({ backendOrgManagement: true });

    const owner = await createDomainUser('backend-owner@example.com');
    const staff = await createDomainUser('backend-staff@example.com');

    const app = await createApp();
    await app.ready();
    const bearer = await seedDomainSecret(handle!.prisma, BACKEND_DOMAIN);
    const headers = { authorization: `Bearer ${bearer}` };

    // --- create, naming the owner explicitly (no acting user to infer one from)
    const createRes = await app.inject({
      method: 'POST',
      url: url('/org/organisations'),
      headers,
      payload: { name: 'Backend Bistro', owner_user_id: owner.id },
    });
    expect(createRes.statusCode).toBe(200);
    const org = createRes.json() as OrgRecord & { ownerId: string };
    expect(org.ownerId).toBe(owner.id);
    expect(org.domain).toBe(BACKEND_DOMAIN);

    // --- read it back
    const readRes = await app.inject({
      method: 'GET',
      url: url(`/org/organisations/${org.id}`),
      headers,
    });
    expect(readRes.statusCode).toBe(200);
    expect((readRes.json() as OrgRecord).id).toBe(org.id);

    // --- rename it (owner/admin standing does not apply to a backend caller)
    const updateRes = await app.inject({
      method: 'PUT',
      url: url(`/org/organisations/${org.id}`),
      headers,
      payload: { name: 'Backend Brasserie' },
    });
    expect(updateRes.statusCode).toBe(200);
    expect((updateRes.json() as OrgRecord).name).toBe('Backend Brasserie');

    // --- add a member by explicit user id
    const addMemberRes = await app.inject({
      method: 'POST',
      url: url(`/org/organisations/${org.id}/members`),
      headers,
      payload: { userId: staff.id, role: 'member' },
    });
    expect(addMemberRes.statusCode).toBe(200);
    expect((addMemberRes.json() as OrgMemberRecord).userId).toBe(staff.id);

    // --- promote them
    const roleRes = await app.inject({
      method: 'PUT',
      url: url(`/org/organisations/${org.id}/members/${staff.id}`),
      headers,
      payload: { role: 'admin' },
    });
    expect(roleRes.statusCode).toBe(200);
    expect((roleRes.json() as OrgMemberRecord).role).toBe('admin');

    // --- create a team and put them in it
    const teamRes = await app.inject({
      method: 'POST',
      url: url(`/org/organisations/${org.id}/teams`),
      headers,
      payload: { name: 'Front of House' },
    });
    expect(teamRes.statusCode).toBe(200);
    const team = teamRes.json() as TeamRecord;

    const teamMemberRes = await app.inject({
      method: 'POST',
      url: url(`/org/organisations/${org.id}/teams/${team.id}/members`),
      headers,
      payload: { userId: staff.id, teamRole: 'admin' },
    });
    expect(teamMemberRes.statusCode).toBe(200);

    const teamReadRes = await app.inject({
      method: 'GET',
      url: url(`/org/organisations/${org.id}/teams/${team.id}`),
      headers,
    });
    expect(teamReadRes.statusCode).toBe(200);
    expect(
      (teamReadRes.json() as TeamWithMembersRecord).members.map((m) => m.userId),
    ).toContain(staff.id);

    await app.close();
  });

  // Attribution is the point of keeping `uoa_actor`: a backend-initiated change
  // must be distinguishable from a user's, and must not name a user who did not
  // act.
  it('audits a backend mutation with no actor user and domain_backend provenance', async () => {
    await stubConfigs({ backendOrgManagement: true });

    const owner = await createDomainUser('audit-owner@example.com');
    const staff = await createDomainUser('audit-staff@example.com');

    const app = await createApp();
    await app.ready();
    const bearer = await seedDomainSecret(handle!.prisma, BACKEND_DOMAIN);
    const headers = { authorization: `Bearer ${bearer}` };

    const createRes = await app.inject({
      method: 'POST',
      url: url('/org/organisations'),
      headers,
      payload: { name: 'Audited Org', owner_user_id: owner.id },
    });
    expect(createRes.statusCode).toBe(200);
    const org = createRes.json() as OrgRecord;

    const addRes = await app.inject({
      method: 'POST',
      url: url(`/org/organisations/${org.id}/members`),
      headers,
      payload: { userId: staff.id, role: 'member' },
    });
    expect(addRes.statusCode).toBe(200);

    const rows = await handle!.prisma.orgAuditLog.findMany({
      where: { orgId: org.id, action: 'member.added' },
      select: { actorUserId: true, metadata: true },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].actorUserId).toBeNull();
    expect((rows[0].metadata as Record<string, unknown>)[ORG_AUDIT_ACTOR_METADATA_KEY]).toEqual({
      via: 'domain_backend',
      source_domain: BACKEND_DOMAIN,
    });

    await app.close();
  });

  // The tenant boundary. A backend authenticated for domain X must not be able
  // to reach domain Y's organisation, even though it holds a perfectly valid
  // credential for its own domain.
  it('cannot read or mutate another domain organisation', async () => {
    await stubConfigs({ backendOrgManagement: true });

    const otherOwner = await createDomainUser('other-owner@example.com', OTHER_DOMAIN);
    const victim = await createDomainUser('victim@example.com', OTHER_DOMAIN);

    const app = await createApp();
    await app.ready();
    const backendBearer = await seedDomainSecret(handle!.prisma, BACKEND_DOMAIN);
    const otherBearer = await seedDomainSecret(handle!.prisma, OTHER_DOMAIN);

    // Domain Y creates its own organisation with its own credential.
    const otherCreate = await app.inject({
      method: 'POST',
      url: url('/org/organisations', OTHER_DOMAIN, OTHER_CONFIG_URL),
      headers: { authorization: `Bearer ${otherBearer}` },
      payload: { name: 'Other Tenant Org', owner_user_id: otherOwner.id },
    });
    expect(otherCreate.statusCode).toBe(200);
    const otherOrg = otherCreate.json() as OrgRecord;

    const backendHeaders = { authorization: `Bearer ${backendBearer}` };

    // Reading domain Y's org as domain X's backend: not found, not forbidden —
    // no cross-domain existence oracle.
    const readRes = await app.inject({
      method: 'GET',
      url: url(`/org/organisations/${otherOrg.id}`),
      headers: backendHeaders,
    });
    expect(readRes.statusCode).toBe(404);

    const updateRes = await app.inject({
      method: 'PUT',
      url: url(`/org/organisations/${otherOrg.id}`),
      headers: backendHeaders,
      payload: { name: 'Hijacked' },
    });
    expect(updateRes.statusCode).toBe(404);

    const addMemberRes = await app.inject({
      method: 'POST',
      url: url(`/org/organisations/${otherOrg.id}/members`),
      headers: backendHeaders,
      payload: { userId: victim.id, role: 'owner' },
    });
    expect(addMemberRes.statusCode).toBe(404);

    const deleteRes = await app.inject({
      method: 'DELETE',
      url: url(`/org/organisations/${otherOrg.id}`),
      headers: backendHeaders,
    });
    expect(deleteRes.statusCode).toBe(404);

    // And nothing changed.
    const stillThere = await handle!.prisma.organisation.findUnique({
      where: { id: otherOrg.id },
      select: { name: true, domain: true },
    });
    expect(stillThere).toEqual({ name: 'Other Tenant Org', domain: OTHER_DOMAIN });

    await app.close();
  });

  // Steering the tenant via the query string must fail before anything runs: the
  // domain-hash bearer is checked against `?domain=`, so a mismatched pair
  // cannot authenticate at all.
  it('rejects a query domain that does not match the credential and config', async () => {
    await stubConfigs({ backendOrgManagement: true });

    const app = await createApp();
    await app.ready();
    const backendBearer = await seedDomainSecret(handle!.prisma, BACKEND_DOMAIN);
    await seedDomainSecret(handle!.prisma, OTHER_DOMAIN);

    const res = await app.inject({
      method: 'GET',
      url: url('/org/organisations', OTHER_DOMAIN, BACKEND_CONFIG_URL),
      headers: { authorization: `Bearer ${backendBearer}` },
    });
    expect(res.statusCode).toBe(401);

    await app.close();
  });

  it('rejects backend mode when the domain has not opted in', async () => {
    await stubConfigs({ backendOrgManagement: false });

    const owner = await createTestUser(handle!, 'no-optin-owner@example.com');

    const app = await createApp();
    await app.ready();
    const bearer = await seedDomainSecret(handle!.prisma, BACKEND_DOMAIN);

    const res = await app.inject({
      method: 'POST',
      url: url('/org/organisations'),
      headers: { authorization: `Bearer ${bearer}` },
      payload: { name: 'Should Not Exist', owner_user_id: owner.id },
    });
    expect(res.statusCode).toBe(401);

    const count = await handle!.prisma.organisation.count();
    expect(count).toBe(0);

    await app.close();
  });

  it('rejects a backend call with no domain-hash bearer at all', async () => {
    await stubConfigs({ backendOrgManagement: true });

    const app = await createApp();
    await app.ready();
    await seedDomainSecret(handle!.prisma, BACKEND_DOMAIN);

    const res = await app.inject({ method: 'GET', url: url('/org/organisations') });
    expect(res.statusCode).toBe(401);

    await app.close();
  });

  it('rejects a backend call whose domain-hash bearer is wrong', async () => {
    await stubConfigs({ backendOrgManagement: true });

    const app = await createApp();
    await app.ready();
    await seedDomainSecret(handle!.prisma, BACKEND_DOMAIN);

    const res = await app.inject({
      method: 'GET',
      url: url('/org/organisations'),
      headers: { authorization: 'Bearer deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' },
    });
    expect(res.statusCode).toBe(401);

    await app.close();
  });

  it('rejects a backend call whose config_url cannot be fetched', async () => {
    await stubConfigs({ backendOrgManagement: true });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));

    const app = await createApp();
    await app.ready();
    const bearer = await seedDomainSecret(handle!.prisma, BACKEND_DOMAIN);

    const res = await app.inject({
      method: 'GET',
      url: url('/org/organisations'),
      headers: { authorization: `Bearer ${bearer}` },
    });
    // AGENTS.md: exact status only. An unfetchable config_url is a client-side
    // input problem, never a server fault.
    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('requires owner_user_id when creating an organisation in backend mode', async () => {
    await stubConfigs({ backendOrgManagement: true });

    const app = await createApp();
    await app.ready();
    const bearer = await seedDomainSecret(handle!.prisma, BACKEND_DOMAIN);

    const res = await app.inject({
      method: 'POST',
      url: url('/org/organisations'),
      headers: { authorization: `Bearer ${bearer}` },
      payload: { name: 'Ownerless' },
    });
    expect(res.statusCode).toBe(400);
    expect(await handle!.prisma.organisation.count()).toBe(0);

    await app.close();
  });

  // M4. In backend mode `owner_user_id` is an id the CALLER chose, and "the user
  // row exists" is not a tenant boundary: `user_scope` defaults to `global`, so
  // in a default deployment every user row has `domain: null` and satisfies the
  // `users_select` policy on every domain. Only the `DomainRole` — the row login
  // writes via `ensureDomainRoleForUser` — proves the named owner ever
  // authenticated HERE. Deleting that check let one tenant's backend mint an
  // organisation owned by a stranger from another tenant, and the whole suite
  // stayed green because every other test seeds the DomainRole.
  it('refuses an owner_user_id that exists but never authenticated on this domain', async () => {
    await stubConfigs({ backendOrgManagement: true });

    // Exists, and belongs to the OTHER tenant — never logged in here.
    const stranger = await createTestUser(handle!, 'stranger@example.com');
    await handle!.prisma.domainRole.create({ data: { domain: OTHER_DOMAIN, userId: stranger.id } });

    const app = await createApp();
    await app.ready();
    const bearer = await seedDomainSecret(handle!.prisma, BACKEND_DOMAIN);

    const res = await app.inject({
      method: 'POST',
      url: url('/org/organisations'),
      headers: { authorization: `Bearer ${bearer}` },
      payload: { name: 'Stranger Org', owner_user_id: stranger.id },
    });

    expect(res.statusCode).toBe(400);
    expect(await handle!.prisma.organisation.count()).toBe(0);

    // The same call succeeds the moment that user has authenticated here, so the
    // rejection is the DomainRole and nothing else.
    await handle!.prisma.domainRole.create({
      data: { domain: BACKEND_DOMAIN, userId: stranger.id },
    });
    const retry = await app.inject({
      method: 'POST',
      url: url('/org/organisations'),
      headers: { authorization: `Bearer ${bearer}` },
      payload: { name: 'Stranger Org', owner_user_id: stranger.id },
    });
    expect(retry.statusCode).toBe(200);

    await app.close();
  });

  it('rejects owner_user_id on the user path, where the actor is the owner', async () => {
    await stubConfigs({ backendOrgManagement: true });

    const actor = await createTestUser(handle!, 'actor@example.com');
    const someoneElse = await createTestUser(handle!, 'someone-else@example.com');

    const app = await createApp();
    await app.ready();
    const bearer = await seedDomainSecret(handle!.prisma, BACKEND_DOMAIN);
    const token = await signAccessToken({
      subject: actor.id,
      domain: BACKEND_DOMAIN,
      secret: process.env.SHARED_SECRET!,
      issuer: process.env.AUTH_SERVICE_IDENTIFIER!,
    });

    const res = await app.inject({
      method: 'POST',
      url: url('/org/organisations'),
      headers: {
        authorization: `Bearer ${bearer}`,
        'x-uoa-access-token': `Bearer ${token}`,
      },
      payload: { name: 'Ambiguous', owner_user_id: someoneElse.id },
    });
    expect(res.statusCode).toBe(400);
    expect(await handle!.prisma.organisation.count()).toBe(0);

    await app.close();
  });

  // These two routes are ABOUT the acting user, so backend mode is meaningless
  // for them and must stay closed rather than invent a subject.
  it('keeps GET /org/me user-token only', async () => {
    await stubConfigs({ backendOrgManagement: true });

    const app = await createApp();
    await app.ready();
    const bearer = await seedDomainSecret(handle!.prisma, BACKEND_DOMAIN);

    const res = await app.inject({
      method: 'GET',
      url: url('/org/me'),
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(res.statusCode).toBe(401);

    await app.close();
  });

  it('keeps team self-join user-token only', async () => {
    await stubConfigs({ backendOrgManagement: true });

    const owner = await createDomainUser('selfjoin-owner@example.com');

    const app = await createApp();
    await app.ready();
    const bearer = await seedDomainSecret(handle!.prisma, BACKEND_DOMAIN);
    const headers = { authorization: `Bearer ${bearer}` };

    const createRes = await app.inject({
      method: 'POST',
      url: url('/org/organisations'),
      headers,
      payload: { name: 'Self Join Org', owner_user_id: owner.id },
    });
    expect(createRes.statusCode).toBe(200);
    const org = createRes.json() as OrgRecord;

    const teamRes = await app.inject({
      method: 'POST',
      url: url(`/org/organisations/${org.id}/teams`),
      headers,
      payload: { name: 'Open Team' },
    });
    expect(teamRes.statusCode).toBe(200);
    const team = teamRes.json() as TeamRecord;

    const joinRes = await app.inject({
      method: 'POST',
      url: url(`/org/organisations/${org.id}/teams/${team.id}/join`),
      headers,
    });
    expect(joinRes.statusCode).toBe(401);

    await app.close();
  });

  // The confidential `token.provision` acceptance is gone. Presenting such a
  // token must fail like any other bad user token, and must NOT be treated as
  // "no token" (which would silently hand it backend authority).
  it('does not accept a confidential RS256 at+jwt resource token on /org', async () => {
    await stubConfigs({ backendOrgManagement: true });

    const app = await createApp();
    await app.ready();
    const bearer = await seedDomainSecret(handle!.prisma, BACKEND_DOMAIN);

    const confidentialToken = [
      Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'at+jwt', kid: 'uoa-access-1' })).toString(
        'base64url',
      ),
      Buffer.from(
        JSON.stringify({
          iss: 'https://authentication.unlikeotherai.com',
          aud: 'https://authentication.unlikeotherai.com/org',
          sub: 'user_1',
          scope: 'token.provision',
          source_domain: BACKEND_DOMAIN,
          azp: BACKEND_DOMAIN,
        }),
      ).toString('base64url'),
      'c2lnbmF0dXJl',
    ].join('.');

    const res = await app.inject({
      method: 'GET',
      url: url('/org/organisations'),
      headers: {
        authorization: `Bearer ${bearer}`,
        'x-uoa-access-token': confidentialToken,
      },
    });
    // The backend-only list route refuses ANY present `X-UOA-Access-Token`.
    // It used to have no guard at all, so this token was ignored and the caller
    // got the domain's organisation list — a token the route would not accept
    // still bought the data the route protects.
    expect(res.statusCode).toBe(401);

    // On a guarded route the same token is rejected as a bad USER token, not
    // silently upgraded to backend mode.
    const guarded = await app.inject({
      method: 'POST',
      url: url('/org/organisations'),
      headers: {
        authorization: `Bearer ${bearer}`,
        'x-uoa-access-token': confidentialToken,
      },
      payload: { name: 'Should Not Exist', owner_user_id: 'user_1' },
    });
    expect(guarded.statusCode).toBe(401);
    expect(await handle!.prisma.organisation.count()).toBe(0);

    await app.close();
  });

  // The user path must be completely unaffected by all of the above.
  it('leaves the user-token path unchanged when backend mode is enabled', async () => {
    await stubConfigs({ backendOrgManagement: true });

    const owner = await createDomainUser('user-path-owner@example.com');
    const outsider = await createDomainUser('outsider@example.com');

    const app = await createApp();
    await app.ready();
    const bearer = await seedDomainSecret(handle!.prisma, BACKEND_DOMAIN);
    const headers = { authorization: `Bearer ${bearer}` };

    const createRes = await app.inject({
      method: 'POST',
      url: url('/org/organisations'),
      headers,
      payload: { name: 'User Path Org', owner_user_id: owner.id },
    });
    expect(createRes.statusCode).toBe(200);
    const org = createRes.json() as OrgRecord;

    // A user with no membership still gets 403 from the org guard, exactly as
    // before — backend mode did not loosen the user path.
    const outsiderToken = await signAccessToken({
      subject: outsider.id,
      domain: BACKEND_DOMAIN,
      secret: process.env.SHARED_SECRET!,
      issuer: process.env.AUTH_SERVICE_IDENTIFIER!,
    });
    const outsiderRes = await app.inject({
      method: 'GET',
      url: url(`/org/organisations/${org.id}`),
      headers: { ...headers, 'x-uoa-access-token': `Bearer ${outsiderToken}` },
    });
    expect(outsiderRes.statusCode).toBe(403);

    // The owner's own token still works and still writes an attributed audit row.
    const ownerToken = await signAccessToken({
      subject: owner.id,
      domain: BACKEND_DOMAIN,
      secret: process.env.SHARED_SECRET!,
      issuer: process.env.AUTH_SERVICE_IDENTIFIER!,
      org: { orgId: org.id, orgRole: 'owner' },
    });
    const ownerAdd = await app.inject({
      method: 'POST',
      url: url(`/org/organisations/${org.id}/members`),
      headers: { ...headers, 'x-uoa-access-token': `Bearer ${ownerToken}` },
      payload: { userId: outsider.id, role: 'member' },
    });
    expect(ownerAdd.statusCode).toBe(200);

    const rows = await handle!.prisma.orgAuditLog.findMany({
      where: { orgId: org.id, action: 'member.added' },
      select: { actorUserId: true, metadata: true },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].actorUserId).toBe(owner.id);
    // Absent key = a user did it. That must stay true.
    expect(
      (rows[0].metadata as Record<string, unknown>)[ORG_AUDIT_ACTOR_METADATA_KEY],
    ).toBeUndefined();

    await app.close();
  });
});
