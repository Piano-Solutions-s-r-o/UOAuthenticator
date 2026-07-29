import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { requireDomainHashAuthForDomainQuery } from '../../middleware/domain-hash-auth.js';
import { createRateLimiter } from '../../middleware/rate-limiter.js';
import { requireUserAccessTokenForDomainQuery } from '../../middleware/user-access-token.js';
import {
  deleteAvatar,
  resolveAvatar,
  uploadAvatar,
} from '../../services/avatar.service.js';
import { normalizeDomain } from '../../utils/domain.js';
import { AppError } from '../../utils/errors.js';
import {
  AVATAR_UPLOAD_BODY_LIMIT,
  AvatarImageQueryFields,
  avatarUploadResponse,
  configDefaultAvatarStyle,
  optionalConfigVerifier,
  readAvatarUpload,
  sendAvatar,
} from './shared.js';

const ImageQuerySchema = z
  .object({
    domain: z.string().trim().min(1),
    config_url: z.string().trim().min(1).max(2048).optional(),
    ...AvatarImageQueryFields,
  })
  .strict();

const MutationQuerySchema = z.object({ domain: z.string().trim().min(1) }).strict();

// Dual auth: the domain-hash bearer authenticates the product backend, the access token
// establishes which user it is acting for. Both are required (Docs/Auth/avatars.md §5).
const dualAuth = [requireDomainHashAuthForDomainQuery, requireUserAccessTokenForDomainQuery];

const mutationRateLimit = createRateLimiter({
  keyBuilder: (request: FastifyRequest) => {
    const query = MutationQuerySchema.safeParse(request.query);
    const domain = query.success ? normalizeDomain(query.data.domain) : 'unknown';
    return `avatar-me-write:${domain}:${request.accessTokenClaims?.userId ?? 'unknown'}`;
  },
  limit: 30,
  windowMs: 60 * 60 * 1000,
});

const uploadResponseSchema = { type: 'object', additionalProperties: true } as const;

/** The acting identity is always the access-token subject — never a path or body value. */
function actingUserId(request: FastifyRequest): string {
  const userId = request.accessTokenClaims?.userId;
  if (!userId) throw new AppError('UNAUTHORIZED', 401, 'MISSING_ACCESS_TOKEN');
  return userId;
}

export function registerAvatarMeRoutes(app: FastifyInstance): void {
  app.get(
    '/avatar/me',
    // Auth first, config second: `optionalConfigVerifier` does attacker-directed outbound work, so
    // it must never run for a caller that is about to get a 401. See `optionalConfigVerifier`.
    { preHandler: [...dualAuth, optionalConfigVerifier] },
    async (request, reply) => {
      const query = ImageQuerySchema.parse(request.query);
      const domain = normalizeDomain(query.domain);

      const avatar = await resolveAvatar({
        userId: actingUserId(request),
        style: query.style ?? null,
        configDefaultStyle: configDefaultAvatarStyle(request, domain),
        size: query.size ?? null,
      });

      return sendAvatar(request, reply, avatar);
    },
  );

  app.put(
    '/avatar/me',
    {
      bodyLimit: AVATAR_UPLOAD_BODY_LIMIT,
      preHandler: [...dualAuth, mutationRateLimit],
      schema: { response: { 200: uploadResponseSchema } },
    },
    async (request) => {
      MutationQuerySchema.parse(request.query);
      const data = await readAvatarUpload(request);

      return avatarUploadResponse(await uploadAvatar({ userId: actingUserId(request), data }));
    },
  );

  app.delete(
    '/avatar/me',
    {
      preHandler: [...dualAuth, mutationRateLimit],
      schema: { response: { 200: uploadResponseSchema } },
    },
    async (request) => {
      MutationQuerySchema.parse(request.query);
      await deleteAvatar({ userId: actingUserId(request) });

      return { ok: true };
    },
  );
}
