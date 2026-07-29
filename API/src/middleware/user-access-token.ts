import type { FastifyReply, FastifyRequest } from 'fastify';

import { verifyAccessToken } from '../services/access-token.service.js';
import { normalizeDomain } from '../utils/domain.js';
import { AppError } from '../utils/errors.js';

function parseBearerOrRawToken(value: unknown): string | null {
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

/**
 * Self-service dual auth for `/avatar/me` (Docs/Auth/avatars.md §5).
 *
 * Identical to `superuser-access-token.ts` except that it requires no role: any authenticated user
 * may manage their own avatar. The domain-hash guard authenticates the calling product backend;
 * this guard establishes *which user* the backend is acting for. The token's `domain` claim must
 * equal `?domain=`, so a token minted for one product cannot drive an avatar change on another.
 * The acting identity is always the token subject — it is never taken from the path or body.
 */
export async function requireUserAccessTokenForDomainQuery(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  void reply;

  const token = parseBearerOrRawToken(request.headers['x-uoa-access-token']);
  if (!token) {
    throw new AppError('UNAUTHORIZED', 401, 'MISSING_ACCESS_TOKEN');
  }

  const claims = await verifyAccessToken(token);

  const domainValue = (request.query as { domain?: unknown } | undefined)?.domain;
  if (typeof domainValue !== 'string' || !domainValue.trim()) {
    throw new AppError('BAD_REQUEST', 400, 'MISSING_DOMAIN');
  }
  const domain = normalizeDomain(domainValue);

  if (normalizeDomain(claims.domain) !== domain) {
    throw new AppError('FORBIDDEN', 403, 'ACCESS_TOKEN_DOMAIN_MISMATCH');
  }

  request.accessTokenClaims = claims;
}
