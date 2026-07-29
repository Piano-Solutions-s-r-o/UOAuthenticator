// End-to-end test of `requireOrgRole` with BOTH token verifiers real.
//
// `src/middleware/__tests__/org-role-guard.test.ts` mocks `verifyAccessToken` and
// `verifyConfidentialProvisioningToken`, so it can only prove call ordering: it
// would stay green if either verifier stopped enforcing anything. Here only the
// Prisma layer is stubbed, so a real HS256 token and a real RS256 `at+jwt` are
// carried through the real guard.
import type { FastifyReply, FastifyRequest } from 'fastify';
import { exportJWK, generateKeyPair, SignJWT, type JWK, type KeyLike } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ACCESS_TOKEN_AUDIENCE } from '../../src/config/constants.js';
import { requireOrgRole } from '../../src/middleware/org-role-guard.js';
import { signConfidentialAccessToken } from '../../src/services/oauth/access-token.service.js';
import { resetAccessTokenKeyCache } from '../../src/services/oauth/access-token.service.js';

const issuer = 'https://authentication.unlikeotherai.com';
const orgAudience = `${issuer}/org`;
const sourceDomain = 'api.hugopos.eu';
const product = 'hugo';
const userId = 'usr_1';
const email = 'venue-owner@example.com';
const sharedSecret = 'integration-shared-secret-with-enough-length';

// Only the database is stubbed. Both verifiers reach for `getAdminPrisma()`
// internally, so this is the single seam that keeps them otherwise real.
const findUser = vi.fn();
const findDomainRole = vi.fn();

vi.mock('../../src/db/prisma.js', () => ({
  getAdminPrisma: () => ({
    user: { findUnique: (...args: unknown[]) => findUser(...args) },
    domainRole: { findUnique: (...args: unknown[]) => findDomainRole(...args) },
  }),
  getPrisma: () => {
    throw new Error('tenant client not expected in this test');
  },
}));

let privateKey: KeyLike;
let privateJwk: JWK;

const originalEnv = {
  DATABASE_URL: process.env.DATABASE_URL,
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
  AUTH_SERVICE_IDENTIFIER: process.env.AUTH_SERVICE_IDENTIFIER,
  SHARED_SECRET: process.env.SHARED_SECRET,
  MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK: process.env.MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK,
};

function restoreEnv(name: keyof typeof originalEnv): void {
  const value = originalEnv[name];
  if (value === undefined) Reflect.deleteProperty(process.env, name);
  else process.env[name] = value;
}

function orgClaim() {
  return {
    org_id: 'org_1',
    org_role: 'owner',
    teams: ['team_1'],
    team_roles: { team_1: 'admin' },
  };
}

/** A real HS256 user access token, exactly as the login flow mints one. */
async function signUserToken(overrides: Record<string, unknown> = {}): Promise<string> {
  return await new SignJWT({
    tv: 0,
    email,
    domain: sourceDomain,
    client_id: 'client-abc',
    role: 'user',
    org: orgClaim(),
    active: { orgId: 'org_1', teamId: 'team_1' },
    ...overrides,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(sourceDomain)
    .setAudience(ACCESS_TOKEN_AUDIENCE)
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime('30m')
    .sign(new TextEncoder().encode(sharedSecret));
}

/** A real confidential resource token, minted through the production signer. */
async function signProvisioningToken(
  overrides: { scope?: string; resource?: string; workspace?: boolean } = {},
): Promise<string> {
  const workspace = overrides.workspace
    ? { org: orgClaim(), active: { orgId: 'org_1', teamId: 'team_1' } }
    : {};

  return await signConfidentialAccessToken({
    subject: userId,
    credentialEpoch: 0,
    email,
    sourceDomain,
    product,
    resource: overrides.resource ?? orgAudience,
    issuer,
    ttlSeconds: 300,
    scope: overrides.scope ?? 'token.provision',
    ...workspace,
  });
}

function makeRequest(token: string, params?: { orgId?: string }): FastifyRequest {
  return {
    headers: { 'x-uoa-access-token': token },
    config: { domain: sourceDomain },
    ...(params ? { params } : {}),
  } as unknown as FastifyRequest;
}

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = pair.privateKey;
  privateJwk = await exportJWK(pair.privateKey);
  Object.assign(privateJwk, { kid: 'uoa-integration-test', alg: 'RS256', use: 'sig' });
  void privateKey;
});

beforeEach(() => {
  process.env.DATABASE_URL = 'postgres://localhost/authenticator-test';
  process.env.PUBLIC_BASE_URL = issuer;
  process.env.AUTH_SERVICE_IDENTIFIER = sourceDomain;
  process.env.SHARED_SECRET = sharedSecret;
  process.env.MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK = JSON.stringify(privateJwk);
  resetAccessTokenKeyCache();
  findUser.mockReset();
  findDomainRole.mockReset();
  findUser.mockResolvedValue({ tokenVersion: 0 });
  findDomainRole.mockResolvedValue({ role: 'USER' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  (Object.keys(originalEnv) as Array<keyof typeof originalEnv>).forEach(restoreEnv);
  resetAccessTokenKeyCache();
});

describe('requireOrgRole with real verifiers', () => {
  it('accepts a real HS256 user token and never consults the confidential path', async () => {
    const middleware = requireOrgRole('owner');
    const request = makeRequest(await signUserToken(), { orgId: 'org_1' });

    await middleware(request, {} as FastifyReply);

    expect(request.accessTokenClaims?.userId).toBe(userId);
    // The HS256 path carries no backend actor — the user acted themselves.
    expect(request.accessTokenClaims?.actor).toBeUndefined();
  });

  it('accepts a real confidential provisioning token and records the acting backend', async () => {
    const middleware = requireOrgRole('owner');
    const request = makeRequest(await signProvisioningToken({ workspace: true }), {
      orgId: 'org_1',
    });

    await middleware(request, {} as FastifyReply);

    expect(request.accessTokenClaims?.userId).toBe(userId);
    expect(request.accessTokenClaims?.actor).toEqual({
      via: 'confidential_provisioning',
      product,
      sourceDomain,
    });
  });

  it('rejects a real confidential token that lacks the token.provision scope', async () => {
    const middleware = requireOrgRole();
    const request = makeRequest(await signProvisioningToken({ scope: 'ai.invoke' }));

    await expect(middleware(request, {} as FastifyReply)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      statusCode: 403,
      message: 'CONFIDENTIAL_SCOPE_MISSING',
    });
  });

  it('rejects a real confidential token bound to a different resource', async () => {
    const middleware = requireOrgRole();
    const request = makeRequest(
      await signProvisioningToken({ resource: 'https://ledger.unlikeotherai.com' }),
    );

    await expect(middleware(request, {} as FastifyReply)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      statusCode: 401,
      message: 'CONFIDENTIAL_TOKEN_INVALID',
    });
  });

  it('rejects a real confidential token whose user lost the source-domain role', async () => {
    findDomainRole.mockResolvedValue(null);
    const middleware = requireOrgRole();
    const request = makeRequest(await signProvisioningToken());

    await expect(middleware(request, {} as FastifyReply)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      statusCode: 403,
      message: 'CONFIDENTIAL_DOMAIN_ROLE_MISSING',
    });
  });

  it('rejects a real confidential token once the credential epoch moves', async () => {
    findUser.mockResolvedValue({ tokenVersion: 7 });
    const middleware = requireOrgRole();
    const request = makeRequest(await signProvisioningToken());

    await expect(middleware(request, {} as FastifyReply)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      statusCode: 401,
      message: 'CONFIDENTIAL_TOKEN_INVALID',
    });
  });

  it('never grants superuser through a confidential token beyond the live domain role', async () => {
    findDomainRole.mockResolvedValue({ role: 'SUPERUSER' });
    const middleware = requireOrgRole();
    const request = makeRequest(await signProvisioningToken());

    await middleware(request, {} as FastifyReply);

    // Mirrors the same user's HS256 token: the role comes from the live row, and
    // the token itself can never assert one.
    expect(request.accessTokenClaims?.role).toBe('superuser');
  });

  /**
   * The DB-outage pass-through invariant.
   *
   * A database fault must surface as an error the caller can retry, NOT as a 401.
   * A 401 reads as "your session ended": clients discard the token and re-auth, so
   * a transient outage would log every user out and stampede the login flow.
   */
  describe('database outage pass-through', () => {
    it('propagates a database error on the HS256 path instead of returning 401', async () => {
      const outage = new Error('prisma: connection terminated unexpectedly');
      findUser.mockRejectedValue(outage);
      const middleware = requireOrgRole('owner');
      const request = makeRequest(await signUserToken(), { orgId: 'org_1' });

      await expect(middleware(request, {} as FastifyReply)).rejects.toBe(outage);
    });

    it('propagates a database error on the confidential path instead of returning 401', async () => {
      const outage = new Error('prisma: connection terminated unexpectedly');
      findUser.mockRejectedValue(outage);
      const middleware = requireOrgRole();
      const request = makeRequest(await signProvisioningToken());

      await expect(middleware(request, {} as FastifyReply)).rejects.toBe(outage);
    });

    it('propagates a domain-role lookup failure rather than masking it as a 403', async () => {
      const outage = new Error('prisma: connection terminated unexpectedly');
      findDomainRole.mockRejectedValue(outage);
      const middleware = requireOrgRole();
      const request = makeRequest(await signProvisioningToken());

      await expect(middleware(request, {} as FastifyReply)).rejects.toBe(outage);
    });
  });
});
