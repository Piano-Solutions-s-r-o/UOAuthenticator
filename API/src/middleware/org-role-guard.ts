import type { FastifyReply, FastifyRequest } from 'fastify';

import { AppError } from '../utils/errors.js';
import { verifyAccessToken, type AccessTokenClaims } from '../services/access-token.service.js';
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
    /**
     * Set by `requireOrgRole` — and by nothing else — when it accepted the request
     * on the domain pairing alone, with no `x-uoa-access-token` present.
     *
     * Its presence is the ONLY proof that "there is deliberately no acting user"
     * rather than "the acting user is missing". Route helpers key on it before
     * they are willing to call a service without an `actorUserId`.
     */
    orgBackendCaller?: { domain: string };
  }
}

function normalizeOrgId(value: string): string {
  return value.trim();
}

/**
 * Resolve the acting user behind `x-uoa-access-token`.
 *
 * There is exactly ONE user-token profile on `/org/*`: the HS256 access token.
 * Every failure mode, error code, and the DB-error passthrough that must never
 * look like a logout are `verifyAccessToken`'s own, unchanged.
 *
 * A product backend that wants to drive `/org/*` server-to-server does not
 * present a token here at all — it omits the header and is authorised by the
 * domain pairing (`requireDomainHashAuthForDomainQuery` + `configVerifier`).
 * See `requireOrgRole` below.
 */
export async function resolveActingUserClaims(token: string): Promise<AccessTokenClaims> {
  return await verifyAccessToken(token);
}

/**
 * Accept the request on the domain pairing alone, with no acting user.
 *
 * The pairing — `requireDomainHashAuthForDomainQuery` (the per-domain hash
 * bearer) plus `configVerifier` (the partner's signed config JWT, tied to
 * `?domain=`) — already proves "this is the backend for domain X". That is the
 * SAME authentication `/org/organisations` (list), the bulk-invite branch of
 * `POST .../invitations`, `/domain/users`, and the `/internal/org/*` family
 * already run on, so nothing new is being trusted here.
 *
 * Three things must hold, and each is re-checked here rather than assumed from
 * the order of the preValidation array, so registering this guard without its
 * siblings fails closed instead of opening a hole:
 *
 *  1. the domain-hash guard actually ran and passed (`domainAuthClientDomainId`);
 *  2. a config JWT was verified, and its `domain` is what we bind to — never the
 *     raw `?domain=` query value;
 *  3. that verified domain opted in via `org_features.backend_org_management`.
 *
 * Without the opt-in this is exactly the old behaviour: 401 `MISSING_ACCESS_TOKEN`.
 */
function acceptDomainBackendCaller(request: FastifyRequest, queryDomain: string): void {
  // (1) The pairing's first half. `verifyDomainHashAuth` sets this only after a
  // constant-time match against the live per-domain secret.
  if (!request.domainAuthClientDomainId) {
    throw new AppError('UNAUTHORIZED', 401, 'MISSING_ACCESS_TOKEN');
  }

  // (2) The pairing's second half. Bind to the VERIFIED config domain, so the
  // tenant a backend call acts on can never be steered by the query string.
  const verifiedDomain = normalizeDomain(request.config?.domain ?? '');
  if (!verifiedDomain) {
    throw new AppError('INTERNAL', 500, 'CONFIG_NOT_VERIFIED');
  }
  if (queryDomain && queryDomain !== verifiedDomain) {
    throw new AppError('BAD_REQUEST', 400, 'DOMAIN_MISMATCH');
  }

  // (3) Explicit opt-in in the partner's own signed config.
  if (request.config?.org_features?.backend_org_management !== true) {
    throw new AppError('UNAUTHORIZED', 401, 'MISSING_ACCESS_TOKEN');
  }

  request.orgBackendCaller = { domain: verifiedDomain };
}

export function requireOrgRole(...requiredRoles: string[]) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    void reply;

    const domain = resolveDomainFromRequest(request);

    const token = parseBearerOrRawToken(request.headers['x-uoa-access-token']);
    if (!token) {
      acceptDomainBackendCaller(request, domain);
      return;
    }

    const claims = await resolveActingUserClaims(token);
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
