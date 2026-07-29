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
  options: { issuer?: string; audience?: string; typ?: string; key?: KeyLike } = {},
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
    .setSubject(userId)
    .setJti('uoa-provisioning-jti')
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
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
