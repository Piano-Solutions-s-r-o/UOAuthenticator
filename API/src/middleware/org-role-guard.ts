import type { FastifyReply, FastifyRequest } from 'fastify';

import { AppError } from '../utils/errors.js';
import { verifyAccessToken, type AccessTokenClaims } from '../services/access-token.service.js';
import {
  isConfidentialProvisioningTokenCandidate,
  verifyConfidentialProvisioningToken,
} from '../services/confidential-provisioning-token.service.js';
import { normalizeDomain } from '../utils/domain.js';

function resolveDomainFromRequest(request: FastifyRequest): string {
  const queryDomain = typeof request.query === 'object' && request.query !== null
    ? (request.query as { domain?: unknown }).domain
    : undefined;
  const normalizedQueryDomain =
    typeof queryDomain === 'string' ? normalizeDomain(queryDomain) : undefined;

  const configDomain = typeof request.config?.domain === 'string' ? normalizeDomain(request.config.domain) : undefined;
  return normalizedQueryDomain || configDomain || '';
}

function resolveOrgIdFromParams(request: FastifyRequest): string | undefined {
  const params = request.params as { orgId?: string } | undefined;
  if (!params?.orgId) return undefined;
  const orgId = params.orgId.trim();
  return orgId || undefined;
}

export function parseBearerOrRawToken(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const lower = trimmed.toLowerCase();
  if (lower.startsWith('bearer ')) {
    const token = trimmed.slice('bearer '.length).trim();
    return token ? token : null;
  }

  return trimmed;
}

declare module 'fastify' {
  interface FastifyRequest {
    accessTokenClaims?: AccessTokenClaims;
  }
}

function normalizeOrgId(value: string): string {
  return value.trim();
}

/**
 * Resolve the acting user behind `x-uoa-access-token`.
 *
 * The HS256 user access token is tried first and its behaviour — including every
 * failure mode, error code, and the DB-error passthrough that must never look
 * like a logout — is unchanged. Only a token that fails that verification AND
 * carries the exact RS256 `at+jwt` protected header of a confidential resource
 * token is re-tried on the confidential provisioning path, so a trusted product
 * backend can act for one of its users server-to-server (see
 * `confidential-provisioning-token.service.ts`). Neither path can widen the org
 * role checks below.
 */
async function resolveActingUserClaims(
  token: string,
  domain: string,
): Promise<AccessTokenClaims> {
  try {
    return await verifyAccessToken(token);
  } catch (userTokenError) {
    if (!isConfidentialProvisioningTokenCandidate(token)) throw userTokenError;
    return await verifyConfidentialProvisioningToken({ token, domain });
  }
}

export function requireOrgRole(...requiredRoles: string[]) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    void reply;

    const token = parseBearerOrRawToken(request.headers['x-uoa-access-token']);
    if (!token) {
      throw new AppError('UNAUTHORIZED', 401, 'MISSING_ACCESS_TOKEN');
    }

    const domain = resolveDomainFromRequest(request);
    const claims = await resolveActingUserClaims(token, domain);
    if (normalizeDomain(claims.domain) !== domain) {
      throw new AppError('FORBIDDEN', 403, 'ACCESS_TOKEN_DOMAIN_MISMATCH');
    }

    const orgId = resolveOrgIdFromParams(request);
    if (requiredRoles.length > 0) {
      const memberOrgId = normalizeOrgId(claims.org?.org_id ?? '');
      if (!memberOrgId || !claims.org?.org_role) {
        throw new AppError('FORBIDDEN', 403, 'INSUFFICIENT_ORG_ROLE');
      }

      if (orgId && normalizeOrgId(memberOrgId) !== orgId) {
        throw new AppError('FORBIDDEN', 403, 'INSUFFICIENT_ORG_ROLE');
      }

      if (!requiredRoles.includes(claims.org.org_role)) {
        throw new AppError('FORBIDDEN', 403, 'INSUFFICIENT_ORG_ROLE');
      }
    } else if (orgId) {
      const memberOrgId = normalizeOrgId(claims.org?.org_id ?? '');
      if (!memberOrgId || memberOrgId !== orgId) {
        throw new AppError('FORBIDDEN', 403, 'INSUFFICIENT_ORG_ROLE');
      }
    }

    request.accessTokenClaims = claims;
  };
}
