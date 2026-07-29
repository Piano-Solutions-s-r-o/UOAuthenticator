import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AccessTokenClaims } from '../../services/access-token.service.js';
import type { FastifyRequest, FastifyReply } from 'fastify';

import { AppError } from '../../utils/errors.js';
import { requireOrgRole } from '../org-role-guard.js';

const verifyAccessTokenMock = vi.fn();
const isConfidentialCandidateMock = vi.fn();
const verifyConfidentialProvisioningTokenMock = vi.fn();

vi.mock('../../services/access-token.service.js', () => {
  return {
    verifyAccessToken: (...args: unknown[]) => verifyAccessTokenMock(...args),
  };
});

vi.mock('../../services/confidential-provisioning-token.service.js', () => {
  return {
    isConfidentialProvisioningTokenCandidate: (...args: unknown[]) =>
      isConfidentialCandidateMock(...args),
    verifyConfidentialProvisioningToken: (...args: unknown[]) =>
      verifyConfidentialProvisioningTokenMock(...args),
  };
});

function buildClaims(overrides: Partial<AccessTokenClaims> = {}): AccessTokenClaims {
  return {
    userId: 'user_1',
    tokenVersion: 0,
    email: 'user@example.com',
    domain: 'client.example.com',
    clientId: 'client-id',
    role: 'user',
    ...overrides,
  };
}

function makeRequest(token: string | null, domain: string, params?: { orgId?: string }) {
  const headers: Record<string, string | undefined> = {};
  if (token !== null) {
    headers['x-uoa-access-token'] = token;
  }

  return {
    headers,
    config: { domain },
    ...(params ? { params } : {}),
  } as unknown as FastifyRequest;
}

describe('requireOrgRole middleware', () => {
  afterEach(() => {
    verifyAccessTokenMock.mockReset();
    isConfidentialCandidateMock.mockReset();
    verifyConfidentialProvisioningTokenMock.mockReset();
  });

  it('rejects when token is missing', async () => {
    const middleware = requireOrgRole('admin');
    const request = makeRequest(null, 'client.example.com');

    await expect(middleware(request, {} as FastifyReply)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      statusCode: 401,
      message: 'MISSING_ACCESS_TOKEN',
    });
  });

  it('rejects when token verification fails', async () => {
    verifyAccessTokenMock.mockRejectedValueOnce(new AppError('UNAUTHORIZED', 401, 'INVALID_ACCESS_TOKEN'));
    const middleware = requireOrgRole('admin');
    const request = makeRequest('bad-token', 'client.example.com');

    await expect(middleware(request, {} as FastifyReply)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      statusCode: 401,
      message: 'INVALID_ACCESS_TOKEN',
    });
  });

  it('rejects when token domain does not match request domain', async () => {
    verifyAccessTokenMock.mockResolvedValueOnce(
      buildClaims({ domain: 'other.example.com' }),
    );
    const middleware = requireOrgRole('admin');
    const request = makeRequest('Bearer valid-token', 'client.example.com');

    await expect(middleware(request, {} as FastifyReply)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      statusCode: 403,
      message: 'ACCESS_TOKEN_DOMAIN_MISMATCH',
    });
  });

  it('rejects when org claim is missing and roles are required', async () => {
    verifyAccessTokenMock.mockResolvedValueOnce(
      buildClaims(),
    );
    const middleware = requireOrgRole('admin');
    const request = makeRequest('Bearer valid-token', 'client.example.com');

    await expect(middleware(request, {} as FastifyReply)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      statusCode: 403,
      message: 'INSUFFICIENT_ORG_ROLE',
    });
  });

  it('rejects when org role is not allowed', async () => {
    verifyAccessTokenMock.mockResolvedValueOnce(
      buildClaims({ org: { org_id: 'org_1', org_role: 'member', teams: [], team_roles: {} } }),
    );
    const middleware = requireOrgRole('admin');
    const request = makeRequest('valid-token', 'client.example.com');

    await expect(middleware(request, {} as FastifyReply)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      statusCode: 403,
      message: 'INSUFFICIENT_ORG_ROLE',
    });
  });

  it('passes with allowed org role', async () => {
    const claims = buildClaims({
      org: { org_id: 'org_1', org_role: 'admin', teams: [], team_roles: {} },
    });
    verifyAccessTokenMock.mockResolvedValueOnce(claims);
    const middleware = requireOrgRole('admin', 'owner');
    const request = makeRequest('valid-token', 'client.example.com');

    await middleware(request, {} as FastifyReply);

    expect(request.accessTokenClaims).toEqual(claims);
  });

  it('passes when no required roles are configured', async () => {
    const claims = buildClaims();
    verifyAccessTokenMock.mockResolvedValueOnce(claims);
    const middleware = requireOrgRole();
    const request = makeRequest('valid-token', 'client.example.com');

    await middleware(request, {} as FastifyReply);

    expect(request.accessTokenClaims).toEqual(claims);
  });

  it('never consults the confidential path for a valid user access token', async () => {
    verifyAccessTokenMock.mockResolvedValueOnce(buildClaims());
    const middleware = requireOrgRole();
    const request = makeRequest('valid-token', 'client.example.com');

    await middleware(request, {} as FastifyReply);

    expect(isConfidentialCandidateMock).not.toHaveBeenCalled();
    expect(verifyConfidentialProvisioningTokenMock).not.toHaveBeenCalled();
  });
});

// Additive confidential provisioning path: a trusted product backend presents an RS256
// `at+jwt` resource token in the same header so it can manage organisations/teams on
// behalf of one of its users. Every org-role decision below stays the shared one.
describe('requireOrgRole middleware — confidential provisioning tokens', () => {
  afterEach(() => {
    verifyAccessTokenMock.mockReset();
    isConfidentialCandidateMock.mockReset();
    verifyConfidentialProvisioningTokenMock.mockReset();
  });

  function rejectUserToken(): void {
    verifyAccessTokenMock.mockRejectedValue(
      new AppError('UNAUTHORIZED', 401, 'INVALID_ACCESS_TOKEN'),
    );
  }

  it('keeps the user-token error when the token is not a confidential token', async () => {
    rejectUserToken();
    isConfidentialCandidateMock.mockReturnValue(false);
    const middleware = requireOrgRole();
    const request = makeRequest('garbage-token', 'client.example.com');

    await expect(middleware(request, {} as FastifyReply)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      statusCode: 401,
      message: 'INVALID_ACCESS_TOKEN',
    });
    expect(verifyConfidentialProvisioningTokenMock).not.toHaveBeenCalled();
  });

  it('accepts a confidential token with no org claim for the org-create bootstrap', async () => {
    rejectUserToken();
    isConfidentialCandidateMock.mockReturnValue(true);
    const claims = buildClaims();
    verifyConfidentialProvisioningTokenMock.mockResolvedValueOnce(claims);
    const middleware = requireOrgRole();
    const request = makeRequest('confidential-token', 'client.example.com');

    await middleware(request, {} as FastifyReply);

    expect(verifyConfidentialProvisioningTokenMock).toHaveBeenCalledWith({
      token: 'confidential-token',
      domain: 'client.example.com',
    });
    expect(request.accessTokenClaims).toEqual(claims);
  });

  it('accepts a confidential token whose org claim matches the path organisation', async () => {
    rejectUserToken();
    isConfidentialCandidateMock.mockReturnValue(true);
    const claims = buildClaims({
      org: { org_id: 'org_1', org_role: 'owner', teams: ['team_1'], team_roles: { team_1: 'admin' } },
      active: { orgId: 'org_1', teamId: 'team_1' },
    });
    verifyConfidentialProvisioningTokenMock.mockResolvedValueOnce(claims);
    const middleware = requireOrgRole();
    const request = makeRequest('confidential-token', 'client.example.com', { orgId: 'org_1' });

    await middleware(request, {} as FastifyReply);

    expect(request.accessTokenClaims).toEqual(claims);
  });

  it('rejects a confidential token scoped to another organisation', async () => {
    rejectUserToken();
    isConfidentialCandidateMock.mockReturnValue(true);
    verifyConfidentialProvisioningTokenMock.mockResolvedValueOnce(
      buildClaims({ org: { org_id: 'org_other', org_role: 'owner', teams: [], team_roles: {} } }),
    );
    const middleware = requireOrgRole();
    const request = makeRequest('confidential-token', 'client.example.com', { orgId: 'org_1' });

    await expect(middleware(request, {} as FastifyReply)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      statusCode: 403,
      message: 'INSUFFICIENT_ORG_ROLE',
    });
  });

  it('rejects a confidential token with no org claim when an org role is required', async () => {
    rejectUserToken();
    isConfidentialCandidateMock.mockReturnValue(true);
    verifyConfidentialProvisioningTokenMock.mockResolvedValueOnce(buildClaims());
    const middleware = requireOrgRole('owner', 'admin');
    const request = makeRequest('confidential-token', 'client.example.com', { orgId: 'org_1' });

    await expect(middleware(request, {} as FastifyReply)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      statusCode: 403,
      message: 'INSUFFICIENT_ORG_ROLE',
    });
  });

  it('rejects a confidential token whose org role is not allowed', async () => {
    rejectUserToken();
    isConfidentialCandidateMock.mockReturnValue(true);
    verifyConfidentialProvisioningTokenMock.mockResolvedValueOnce(
      buildClaims({ org: { org_id: 'org_1', org_role: 'member', teams: [], team_roles: {} } }),
    );
    const middleware = requireOrgRole('owner', 'admin');
    const request = makeRequest('confidential-token', 'client.example.com', { orgId: 'org_1' });

    await expect(middleware(request, {} as FastifyReply)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      statusCode: 403,
      message: 'INSUFFICIENT_ORG_ROLE',
    });
  });

  it('applies the shared domain check to confidential claims', async () => {
    rejectUserToken();
    isConfidentialCandidateMock.mockReturnValue(true);
    verifyConfidentialProvisioningTokenMock.mockResolvedValueOnce(
      buildClaims({ domain: 'other.example.com' }),
    );
    const middleware = requireOrgRole();
    const request = makeRequest('confidential-token', 'client.example.com');

    await expect(middleware(request, {} as FastifyReply)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      statusCode: 403,
      message: 'ACCESS_TOKEN_DOMAIN_MISMATCH',
    });
  });

  it('surfaces the confidential verification error code to the caller', async () => {
    rejectUserToken();
    isConfidentialCandidateMock.mockReturnValue(true);
    verifyConfidentialProvisioningTokenMock.mockRejectedValueOnce(
      new AppError('FORBIDDEN', 403, 'CONFIDENTIAL_SCOPE_MISSING'),
    );
    const middleware = requireOrgRole();
    const request = makeRequest('confidential-token', 'client.example.com');

    await expect(middleware(request, {} as FastifyReply)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      statusCode: 403,
      message: 'CONFIDENTIAL_SCOPE_MISSING',
    });
  });
});

/**
 * Mutation-resistance cases for the guard itself.
 *
 * The suite above proves call ordering against mocked services. These prove that
 * specific lines of `org-role-guard.ts` cannot be deleted while the suite stays
 * green.
 */
describe('requireOrgRole — checks that must not be deletable', () => {
  afterEach(() => {
    verifyAccessTokenMock.mockReset();
    isConfidentialCandidateMock.mockReset();
    verifyConfidentialProvisioningTokenMock.mockReset();
  });

  // Defends the `orgId` match INSIDE the `requiredRoles.length > 0` branch.
  // The existing cross-org test calls `requireOrgRole()` with no roles, so it only
  // exercises the role-less branch; deleting the guarded match left it green while
  // an owner token for org A reached org B's owner-only endpoints, which do not
  // re-check the actor themselves.
  it('rejects a token whose org role is sufficient but whose org is a different one', async () => {
    verifyAccessTokenMock.mockResolvedValueOnce(
      buildClaims({
        org: { org_id: 'org_other', org_role: 'owner', teams: [], team_roles: {} },
      }),
    );
    const middleware = requireOrgRole('owner', 'admin');
    const request = makeRequest('user-token', 'client.example.com', { orgId: 'org_1' });

    await expect(middleware(request, {} as FastifyReply)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      statusCode: 403,
      message: 'INSUFFICIENT_ORG_ROLE',
    });
  });

  // Defends `throw userTokenError` — the HS256 error must be re-thrown UNCHANGED.
  // A Prisma outage surfaces from `verifyAccessToken` as a 5xx; replacing the
  // rethrow with a fresh 401 would turn every database blip into what looks to a
  // client like a logout, and clients would discard valid sessions.
  it('rethrows the original HS256 error object when the token is not a confidential candidate', async () => {
    const outage = new Error('prisma: connection terminated unexpectedly');
    verifyAccessTokenMock.mockRejectedValueOnce(outage);
    isConfidentialCandidateMock.mockReturnValue(false);
    const middleware = requireOrgRole('admin');
    const request = makeRequest('user-token', 'client.example.com');

    await expect(middleware(request, {} as FastifyReply)).rejects.toBe(outage);
    expect(verifyConfidentialProvisioningTokenMock).not.toHaveBeenCalled();
  });

  // A database outage must not be converted into a 401 on the confidential path
  // either — the same logout-shaped failure, one layer down.
  it('propagates a confidential-path error rather than masking it as a 401', async () => {
    verifyAccessTokenMock.mockRejectedValueOnce(
      new AppError('UNAUTHORIZED', 401, 'INVALID_ACCESS_TOKEN'),
    );
    isConfidentialCandidateMock.mockReturnValue(true);
    const outage = new Error('prisma: connection terminated unexpectedly');
    verifyConfidentialProvisioningTokenMock.mockRejectedValueOnce(outage);
    const middleware = requireOrgRole('admin');
    const request = makeRequest('confidential-token', 'client.example.com');

    await expect(middleware(request, {} as FastifyReply)).rejects.toBe(outage);
  });

  // Defends the domain binding. A confidential token minted for one product domain
  // must never act on another product's tenant, even with a valid signature.
  it('rejects a confidential token whose domain does not match the request domain', async () => {
    verifyAccessTokenMock.mockRejectedValueOnce(
      new AppError('UNAUTHORIZED', 401, 'INVALID_ACCESS_TOKEN'),
    );
    isConfidentialCandidateMock.mockReturnValue(true);
    verifyConfidentialProvisioningTokenMock.mockResolvedValueOnce(
      buildClaims({ domain: 'other.example.com' }),
    );
    const middleware = requireOrgRole();
    const request = makeRequest('confidential-token', 'client.example.com');

    await expect(middleware(request, {} as FastifyReply)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      statusCode: 403,
      message: 'ACCESS_TOKEN_DOMAIN_MISMATCH',
    });
  });
});
