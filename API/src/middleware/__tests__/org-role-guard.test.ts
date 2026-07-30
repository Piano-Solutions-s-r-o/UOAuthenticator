import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AccessTokenClaims } from '../../services/access-token.service.js';
import type { FastifyRequest, FastifyReply } from 'fastify';

import { AppError } from '../../utils/errors.js';
import { requireOrgRole } from '../org-role-guard.js';

const verifyAccessTokenMock = vi.fn();

vi.mock('../../services/access-token.service.js', () => {
  return {
    verifyAccessToken: (...args: unknown[]) => verifyAccessTokenMock(...args),
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
});

/**
 * Mutation-resistance cases for the guard itself.
 *
 * The suite above proves call ordering against a mocked verifier. These prove
 * that specific lines of `org-role-guard.ts` cannot be deleted while the suite
 * stays green.
 */
describe('requireOrgRole — checks that must not be deletable', () => {
  afterEach(() => {
    verifyAccessTokenMock.mockReset();
  });

  // Defends the `orgId` match INSIDE the `requiredRoles.length > 0` branch.
  // The cross-org test above calls `requireOrgRole()` with no roles, so it only
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

  // The user-token verifier's error object must reach the caller UNCHANGED. A
  // Prisma outage surfaces from `verifyAccessToken` as a 5xx; replacing it with a
  // fresh 401 would turn every database blip into what looks to a client like a
  // logout, and clients would discard otherwise-valid sessions.
  it('rethrows the original error object from the user-token verifier', async () => {
    const outage = new Error('prisma: connection terminated unexpectedly');
    verifyAccessTokenMock.mockRejectedValueOnce(outage);
    const middleware = requireOrgRole('admin');
    const request = makeRequest('user-token', 'client.example.com');

    await expect(middleware(request, {} as FastifyReply)).rejects.toBe(outage);
  });
});
