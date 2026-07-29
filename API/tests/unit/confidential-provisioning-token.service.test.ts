import { exportJWK, generateKeyPair, SignJWT, type JWK, type KeyLike } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getOrgProvisioningAudience,
  isConfidentialProvisioningTokenCandidate,
  verifyConfidentialProvisioningToken,
  type ConfidentialProvisioningDeps,
} from '../../src/services/confidential-provisioning-token.service.js';
import {
  resetAccessTokenKeyCache,
  signConfidentialAccessToken,
} from '../../src/services/oauth/access-token.service.js';

const issuer = 'https://authentication.unlikeotherai.com';
const audience = `${issuer}/org`;
const sourceDomain = 'api.hugopos.eu';
const product = 'hugo';
const userId = 'usr_1';
const email = 'venue-owner@example.com';

let privateKey: KeyLike;
let privateJwk: JWK;
let keyId: string;

const originalEnv = {
  DATABASE_URL: process.env.DATABASE_URL,
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
  MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK: process.env.MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK,
};

function restoreEnv(name: keyof typeof originalEnv): void {
  const value = originalEnv[name];
  if (value === undefined) Reflect.deleteProperty(process.env, name);
  else process.env[name] = value;
}

function defaultOrg() {
  return {
    org_id: 'org_1',
    org_role: 'owner',
    teams: ['team_1', 'team_2'],
    team_roles: { team_1: 'admin', team_2: 'member' },
  };
}

/** Prisma stand-in for the two DB-authoritative reads the verifier performs. */
function deps(
  overrides: {
    tokenVersion?: number | null;
    domainRole?: 'SUPERUSER' | 'USER' | null;
    now?: number;
  } = {},
): ConfidentialProvisioningDeps {
  const tokenVersion = overrides.tokenVersion === undefined ? 0 : overrides.tokenVersion;
  const domainRole = overrides.domainRole === undefined ? 'USER' : overrides.domainRole;

  return {
    prisma: {
      user: {
        findUnique: async () => (tokenVersion === null ? null : { tokenVersion }),
      },
      domainRole: {
        findUnique: async () => (domainRole === null ? null : { role: domainRole }),
      },
    } as unknown as ConfidentialProvisioningDeps['prisma'],
    ...(overrides.now === undefined ? {} : { now: () => overrides.now! }),
  };
}

/** Mint through the real signer so the verifier is tested against production tokens. */
async function mintProvisioningToken(
  overrides: {
    scope?: string;
    resource?: string;
    sourceDomain?: string;
    ttlSeconds?: number;
    workspace?: boolean;
    credentialEpoch?: number;
  } = {},
): Promise<string> {
  const workspace = overrides.workspace
    ? { org: defaultOrg(), active: { orgId: 'org_1', teamId: 'team_1' } }
    : {};

  return await signConfidentialAccessToken({
    subject: userId,
    credentialEpoch: overrides.credentialEpoch ?? 0,
    email,
    sourceDomain: overrides.sourceDomain ?? sourceDomain,
    product,
    resource: overrides.resource ?? audience,
    issuer,
    ttlSeconds: overrides.ttlSeconds ?? 300,
    scope: overrides.scope ?? 'token.provision',
    ...workspace,
  });
}

/** Hand-rolled variants for claim shapes the production signer cannot emit. */
async function signRawToken(
  payload: Record<string, unknown>,
  options: {
    issuer?: string;
    audience?: string | string[];
    typ?: string;
    key?: KeyLike;
    iat?: number;
    exp?: number;
    subject?: string;
  } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  return await new SignJWT({
    tv: 0,
    email,
    source_domain: sourceDomain,
    azp: sourceDomain,
    product,
    scope: 'token.provision',
    ...payload,
  })
    .setProtectedHeader({ alg: 'RS256', kid: keyId, typ: options.typ ?? 'at+jwt' })
    .setIssuer(options.issuer ?? issuer)
    .setAudience(options.audience ?? audience)
    .setSubject(options.subject ?? userId)
    .setJti('uoa-provisioning-jti')
    .setIssuedAt(options.iat ?? now)
    .setExpirationTime(options.exp ?? now + 300)
    .sign(options.key ?? privateKey);
}

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = pair.privateKey;
  privateJwk = await exportJWK(pair.privateKey);
  keyId = 'uoa-provisioning-test';
  Object.assign(privateJwk, { kid: keyId, alg: 'RS256', use: 'sig' });
});

beforeEach(() => {
  process.env.DATABASE_URL = 'postgres://localhost/authenticator-test';
  process.env.PUBLIC_BASE_URL = issuer;
  process.env.MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK = JSON.stringify(privateJwk);
  resetAccessTokenKeyCache();
});

afterAll(() => {
  restoreEnv('DATABASE_URL');
  restoreEnv('PUBLIC_BASE_URL');
  restoreEnv('MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK');
  resetAccessTokenKeyCache();
});

describe('org-provisioning audience', () => {
  it('is the public base URL plus the /org resource path', () => {
    expect(getOrgProvisioningAudience()).toBe('https://authentication.unlikeotherai.com/org');
  });
});

describe('confidential provisioning token candidacy', () => {
  it('accepts the RS256 at+jwt protected header the exchange mints', async () => {
    const token = await mintProvisioningToken();

    expect(isConfidentialProvisioningTokenCandidate(token)).toBe(true);
  });

  it('rejects an HS256 user access token', async () => {
    const token = await new SignJWT({ domain: sourceDomain })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(issuer)
      .setSubject(userId)
      .setIssuedAt()
      .setExpirationTime('30m')
      .sign(new TextEncoder().encode('test-shared-secret-with-enough-length'));

    expect(isConfidentialProvisioningTokenCandidate(token)).toBe(false);
  });

  it('rejects a garbage token', () => {
    expect(isConfidentialProvisioningTokenCandidate('not-a-jwt')).toBe(false);
  });
});

describe('verifyConfidentialProvisioningToken', () => {
  it('maps an identity-only token onto bootstrap claims with no org context', async () => {
    const token = await mintProvisioningToken();

    const claims = await verifyConfidentialProvisioningToken(
      { token, domain: sourceDomain },
      deps(),
    );

    expect(claims).toEqual({
      userId,
      tokenVersion: 0,
      email,
      domain: sourceDomain,
      clientId: sourceDomain,
      role: 'user',
      actor: { via: 'confidential_provisioning', product, sourceDomain },
    });
  });

  it('carries the org and active workspace claims through unchanged', async () => {
    const token = await mintProvisioningToken({ workspace: true });

    const claims = await verifyConfidentialProvisioningToken(
      { token, domain: sourceDomain },
      deps(),
    );

    expect(claims).toEqual({
      userId,
      tokenVersion: 0,
      email,
      domain: sourceDomain,
      clientId: sourceDomain,
      role: 'user',
      actor: { via: 'confidential_provisioning', product, sourceDomain },
      org: defaultOrg(),
      active: { orgId: 'org_1', teamId: 'team_1' },
    });
  });

  it('reads the acting role from the live domain role rather than the token', async () => {
    const token = await mintProvisioningToken();

    const claims = await verifyConfidentialProvisioningToken(
      { token, domain: sourceDomain },
      deps({ domainRole: 'SUPERUSER' }),
    );

    expect(claims.role).toBe('superuser');
  });

  it('rejects a token bound to another resource', async () => {
    const token = await mintProvisioningToken({ resource: 'https://ledger.unlikeotherai.com' });

    await expect(
      verifyConfidentialProvisioningToken({ token, domain: sourceDomain }, deps()),
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      statusCode: 401,
      message: 'CONFIDENTIAL_TOKEN_INVALID',
    });
  });

  it('rejects a token bound to a path under the org resource', async () => {
    const token = await mintProvisioningToken({ resource: `${audience}/organisations` });

    await expect(
      verifyConfidentialProvisioningToken({ token, domain: sourceDomain }, deps()),
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      statusCode: 401,
      message: 'CONFIDENTIAL_TOKEN_INVALID',
    });
  });

  it('rejects a token issued by anyone other than this service', async () => {
    const token = await signRawToken({}, { issuer: 'https://evil.example' });

    await expect(
      verifyConfidentialProvisioningToken({ token, domain: sourceDomain }, deps()),
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      statusCode: 401,
      message: 'CONFIDENTIAL_TOKEN_INVALID',
    });
  });

  it('rejects a token signed by a foreign key', async () => {
    const foreign = await generateKeyPair('RS256', { extractable: true });
    const token = await signRawToken({}, { key: foreign.privateKey });

    await expect(
      verifyConfidentialProvisioningToken({ token, domain: sourceDomain }, deps()),
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      statusCode: 401,
      message: 'CONFIDENTIAL_TOKEN_INVALID',
    });
  });

  it('rejects a token whose protected header is not at+jwt', async () => {
    const token = await signRawToken({}, { typ: 'JWT' });

    await expect(
      verifyConfidentialProvisioningToken({ token, domain: sourceDomain }, deps()),
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      statusCode: 401,
      message: 'CONFIDENTIAL_TOKEN_INVALID',
    });
  });

  it('rejects a garbage token', async () => {
    await expect(
      verifyConfidentialProvisioningToken({ token: 'not-a-jwt', domain: sourceDomain }, deps()),
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      statusCode: 401,
      message: 'CONFIDENTIAL_TOKEN_INVALID',
    });
  });

  it('rejects an expired token', async () => {
    const token = await mintProvisioningToken({ ttlSeconds: 60 });
    const wellPastExpiry = Math.floor(Date.now() / 1000) + 600;

    await expect(
      verifyConfidentialProvisioningToken(
        { token, domain: sourceDomain },
        deps({ now: wellPastExpiry }),
      ),
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      statusCode: 401,
      message: 'CONFIDENTIAL_TOKEN_INVALID',
    });
  });

  it('rejects a token whose lifetime exceeds the confidential access-token cap', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      tv: 0,
      email,
      source_domain: sourceDomain,
      azp: sourceDomain,
      product,
      scope: 'token.provision',
    })
      .setProtectedHeader({ alg: 'RS256', kid: keyId, typ: 'at+jwt' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject(userId)
      .setJti('uoa-provisioning-jti')
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(privateKey);

    await expect(
      verifyConfidentialProvisioningToken({ token, domain: sourceDomain }, deps({ now })),
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      statusCode: 401,
      message: 'CONFIDENTIAL_TOKEN_INVALID',
    });
  });

  it('rejects an org claim minted without its active workspace', async () => {
    const token = await signRawToken({ org: defaultOrg() });

    await expect(
      verifyConfidentialProvisioningToken({ token, domain: sourceDomain }, deps()),
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      statusCode: 401,
      message: 'CONFIDENTIAL_TOKEN_INVALID',
    });
  });

  it('rejects an active team outside the token org context', async () => {
    const token = await signRawToken({
      org: defaultOrg(),
      active: { orgId: 'org_1', teamId: 'team_not_in_org' },
    });

    await expect(
      verifyConfidentialProvisioningToken({ token, domain: sourceDomain }, deps()),
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      statusCode: 401,
      message: 'CONFIDENTIAL_TOKEN_INVALID',
    });
  });

  it('rejects a non-canonical scope string', async () => {
    const token = await signRawToken({ scope: 'token.provision ai.invoke' });

    await expect(
      verifyConfidentialProvisioningToken({ token, domain: sourceDomain }, deps()),
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      statusCode: 401,
      message: 'CONFIDENTIAL_TOKEN_INVALID',
    });
  });

  it('rejects a token acting on a domain other than its source domain', async () => {
    const token = await mintProvisioningToken();

    await expect(
      verifyConfidentialProvisioningToken({ token, domain: 'staging.api.hugopos.eu' }, deps()),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      statusCode: 403,
      message: 'CONFIDENTIAL_TOKEN_DOMAIN_MISMATCH',
    });
  });

  it('rejects a token without the token.provision scope', async () => {
    const token = await mintProvisioningToken({ scope: 'ai.invoke' });

    await expect(
      verifyConfidentialProvisioningToken({ token, domain: sourceDomain }, deps()),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      statusCode: 403,
      message: 'CONFIDENTIAL_SCOPE_MISSING',
    });
  });

  it('accepts token.provision alongside another granted scope', async () => {
    const token = await mintProvisioningToken({ scope: 'ai.invoke token.provision' });

    const claims = await verifyConfidentialProvisioningToken(
      { token, domain: sourceDomain },
      deps(),
    );

    expect(claims.userId).toBe(userId);
  });

  it('rejects a token whose credential epoch is stale', async () => {
    const token = await mintProvisioningToken({ credentialEpoch: 0 });

    await expect(
      verifyConfidentialProvisioningToken(
        { token, domain: sourceDomain },
        deps({ tokenVersion: 1 }),
      ),
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      statusCode: 401,
      message: 'CONFIDENTIAL_TOKEN_INVALID',
    });
  });

  it('rejects a token whose subject user no longer exists', async () => {
    const token = await mintProvisioningToken();

    await expect(
      verifyConfidentialProvisioningToken(
        { token, domain: sourceDomain },
        deps({ tokenVersion: null }),
      ),
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      statusCode: 401,
      message: 'CONFIDENTIAL_TOKEN_INVALID',
    });
  });

  it('rejects a token whose subject lost their role on the source domain', async () => {
    const token = await mintProvisioningToken();

    await expect(
      verifyConfidentialProvisioningToken(
        { token, domain: sourceDomain },
        deps({ domainRole: null }),
      ),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      statusCode: 403,
      message: 'CONFIDENTIAL_DOMAIN_ROLE_MISSING',
    });
  });

  it('surfaces an unexpected database failure instead of a false 401', async () => {
    const token = await mintProvisioningToken();
    const databaseFailure = new Error('database unavailable');

    await expect(
      verifyConfidentialProvisioningToken(
        { token, domain: sourceDomain },
        {
          prisma: {
            user: { findUnique: vi.fn().mockRejectedValue(databaseFailure) },
            domainRole: { findUnique: vi.fn().mockResolvedValue({ role: 'USER' }) },
          } as unknown as ConfidentialProvisioningDeps['prisma'],
        },
      ),
    ).rejects.toBe(databaseFailure);
  });
});

/**
 * Mutation-resistance suite.
 *
 * Every case below fails if the specific check it names is deleted from
 * `confidential-provisioning-token.service.ts`. The suite that shipped with the
 * feature passed with several of these checks removed, so each test states the
 * line it is defending.
 */
describe('confidential provisioning token — checks that must not be deletable', () => {
  const invalid = {
    code: 'UNAUTHORIZED',
    statusCode: 401,
    message: 'CONFIDENTIAL_TOKEN_INVALID',
  };

  // `jwtVerify` accepts a multi-valued `aud` when ONE member matches, so a token
  // minted for some other resource that merely LISTS the org audience reaches the
  // payload checks. What actually rejects it is the schema's `aud: z.string()` —
  // an array never parses — with `parsed.aud !== audience` as a second line of
  // defence should the schema ever be widened. Both are load-bearing together;
  // this asserts the outcome they jointly guarantee.
  it('rejects a token whose aud is an array containing the org audience', async () => {
    const token = await signRawToken(
      {},
      { audience: ['https://ledger.unlikeotherai.com', audience] },
    );

    await expect(
      verifyConfidentialProvisioningToken({ token, domain: sourceDomain }, deps()),
    ).rejects.toMatchObject(invalid);
  });

  // Defends `parsed.azp !== sourceDomain`. `azp` names the authorized party; a
  // token whose azp disagrees with its source_domain is not a coherent grant.
  it('rejects a token whose azp differs from its source_domain', async () => {
    const token = await signRawToken({ azp: 'api.attacker.example' });

    await expect(
      verifyConfidentialProvisioningToken({ token, domain: sourceDomain }, deps()),
    ).rejects.toMatchObject(invalid);
  });

  // Defends `parsed.source_domain !== sourceDomain` (the canonical-form assert).
  // `azp` is left canonical on purpose so the azp binding cannot mask the failure
  // — only the source_domain assert can reject these. Without it a non-canonical
  // spelling would normalise into a domain match.
  it.each([
    ['uppercase', 'API.HUGOPOS.EU'],
    ['a trailing dot', 'api.hugopos.eu.'],
  ])('rejects a token whose source_domain is non-canonical (%s)', async (_label, raw) => {
    const token = await signRawToken({ source_domain: raw, azp: sourceDomain });

    await expect(
      verifyConfidentialProvisioningToken({ token, domain: sourceDomain }, deps()),
    ).rejects.toMatchObject(invalid);
  });

  // Defends `parsed.iat > now + clockTolerance`. jose does not reject a future
  // `iat` on its own, so without this check a token could be minted ahead of time
  // and banked.
  it('rejects a token issued in the future beyond the clock tolerance', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signRawToken({}, { iat: now + 120, exp: now + 300 });

    await expect(
      verifyConfidentialProvisioningToken({ token, domain: sourceDomain }, deps({ now })),
    ).rejects.toMatchObject(invalid);
  });

  // Defends `parsed.exp <= now`. jose is configured with a 5s clockTolerance, so
  // a token 3s past expiry still satisfies `jwtVerify`; only the manual check
  // bites. Deleting it silently extends every token's life by 5 seconds.
  it('rejects a token that expired inside jose clock tolerance', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signRawToken({}, { iat: now - 300, exp: now - 3 });

    await expect(
      verifyConfidentialProvisioningToken({ token, domain: sourceDomain }, deps({ now })),
    ).rejects.toMatchObject(invalid);
  });

  // Defends the own-property lookup on `team_roles`. A bare index resolves
  // `Object.prototype.constructor`, so this token passed the consistency check
  // while naming a team it never carried a role for.
  it('rejects an active teamId that only resolves through Object.prototype', async () => {
    const token = await signRawToken({
      org: {
        org_id: 'org_1',
        org_role: 'owner',
        teams: ['constructor'],
        team_roles: { team_1: 'admin' },
      },
      active: { orgId: 'org_1', teamId: 'constructor' },
    });

    await expect(
      verifyConfidentialProvisioningToken({ token, domain: sourceDomain }, deps()),
    ).rejects.toMatchObject(invalid);
  });

  // Defends the same-identity-domain assert. A chained token's `org` is resolved
  // under the ORIGINAL origin at the tail of `act` while `source_domain` names the
  // latest hop, so the two can disagree — unlike the HS256 path, where they are
  // same-domain by construction.
  it('rejects a chained token whose org was minted under another identity domain', async () => {
    const token = await signRawToken({
      org: defaultOrg(),
      active: { orgId: 'org_1', teamId: 'team_1' },
      act: { sub: 'api.nessie.works', product: 'nessie' },
    });

    await expect(
      verifyConfidentialProvisioningToken({ token, domain: sourceDomain }, deps()),
    ).rejects.toMatchObject(invalid);
  });

  it('accepts a chained token whose act chain stays on the same identity domain', async () => {
    const token = await signRawToken({
      org: defaultOrg(),
      active: { orgId: 'org_1', teamId: 'team_1' },
      act: { sub: sourceDomain, product: 'upstream' },
    });

    const claims = await verifyConfidentialProvisioningToken(
      { token, domain: sourceDomain },
      deps(),
    );

    expect(claims.actor).toEqual({
      via: 'confidential_provisioning',
      product,
      sourceDomain,
      chain: [{ sub: sourceDomain, product: 'upstream' }],
    });
  });

  // A token minted for the public/MCP OAuth profile is signed by the SAME keypair.
  // It is refused here on audience alone today, but only because
  // MCP_OAUTH_RESOURCES_SUPPORTED never contains `<base>/org` — configuration, not
  // code. Assert the refusal so the code-level boundary is tested directly.
  it('rejects an MCP-profile token bound to the org audience', async () => {
    const token = await signRawToken(
      { scope: 'token.provision', client_id: 'mcp-client' },
      { typ: 'JWT' },
    );

    await expect(
      verifyConfidentialProvisioningToken({ token, domain: sourceDomain }, deps()),
    ).rejects.toMatchObject(invalid);
  });
});

describe('confidential provisioning token — database authority', () => {
  // The epoch lookup must key on the TOKEN's subject. A lookup on any other id
  // would compare a stale token against the wrong user's epoch and accept it.
  it('looks the credential epoch up by the token subject', async () => {
    const findUser = vi.fn(async () => ({ tokenVersion: 0 }));
    const findRole = vi.fn(async () => ({ role: 'USER' as const }));
    const token = await signRawToken({}, { subject: 'usr_specific' });

    await verifyConfidentialProvisioningToken(
      { token, domain: sourceDomain },
      {
        prisma: {
          user: { findUnique: findUser },
          domainRole: { findUnique: findRole },
        } as unknown as ConfidentialProvisioningDeps['prisma'],
      },
    );

    expect(findUser).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'usr_specific' } }),
    );
  });

  // The role lookup must key on (source_domain, subject). Keying on any other
  // domain could import a SUPERUSER role the user holds somewhere else.
  it('looks the domain role up by source domain and token subject together', async () => {
    const findUser = vi.fn(async () => ({ tokenVersion: 0 }));
    const findRole = vi.fn(async () => ({ role: 'USER' as const }));
    const token = await signRawToken({}, { subject: 'usr_specific' });

    await verifyConfidentialProvisioningToken(
      { token, domain: sourceDomain },
      {
        prisma: {
          user: { findUnique: findUser },
          domainRole: { findUnique: findRole },
        } as unknown as ConfidentialProvisioningDeps['prisma'],
      },
    );

    expect(findRole).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { domain_userId: { domain: sourceDomain, userId: 'usr_specific' } },
      }),
    );
  });

  // A DB fault is an outage, not a credential failure. Turning it into a 401
  // makes every client discard a valid token and re-exchange.
  it('propagates an unexpected database error instead of returning 401', async () => {
    const token = await mintProvisioningToken();
    const boom = new Error('connection terminated');

    await expect(
      verifyConfidentialProvisioningToken(
        { token, domain: sourceDomain },
        {
          prisma: {
            user: {
              findUnique: async () => {
                throw boom;
              },
            },
            domainRole: { findUnique: async () => ({ role: 'USER' as const }) },
          } as unknown as ConfidentialProvisioningDeps['prisma'],
        },
      ),
    ).rejects.toBe(boom);
  });

  // Without a database none of the checks above can run. The HS256 path may skip
  // its lookup in DB-less boot mode; this path must not, because `DomainRole` is
  // an authorization gate rather than pure revocation.
  it('fails closed when no database is configured', async () => {
    const token = await mintProvisioningToken();
    Reflect.deleteProperty(process.env, 'DATABASE_URL');

    await expect(
      verifyConfidentialProvisioningToken({ token, domain: sourceDomain }, {}),
    ).rejects.toMatchObject({
      code: 'INTERNAL',
      statusCode: 500,
      message: 'DATABASE_DISABLED',
    });
  });

  // A missing signing key is a server misconfiguration. Laundering it into a 401
  // tells the caller its token is bad and starts a re-exchange loop.
  it('surfaces a missing signing key as 5xx rather than an invalid token', async () => {
    const token = await mintProvisioningToken();
    Reflect.deleteProperty(process.env, 'MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK');
    resetAccessTokenKeyCache();

    await expect(
      verifyConfidentialProvisioningToken({ token, domain: sourceDomain }, deps()),
    ).rejects.toMatchObject({ code: 'INTERNAL', statusCode: 500 });
  });
});

describe('confidential provisioning token — org role projection', () => {
  // Every workspace happy-path token in the original suite carried org_role
  // "owner", so a regression projecting every role as owner stayed green.
  it.each(['member', 'admin', 'owner'])('projects org_role %s verbatim', async (orgRole) => {
    const token = await signRawToken({
      org: { ...defaultOrg(), org_role: orgRole },
      active: { orgId: 'org_1', teamId: 'team_1' },
    });

    const claims = await verifyConfidentialProvisioningToken(
      { token, domain: sourceDomain },
      deps(),
    );

    expect(claims.org?.org_role).toBe(orgRole);
  });
});
