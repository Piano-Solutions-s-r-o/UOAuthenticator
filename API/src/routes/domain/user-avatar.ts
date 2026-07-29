import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { requireDomainHashAuthForDomainQuery } from '../../middleware/domain-hash-auth.js';
import { createRateLimiter } from '../../middleware/rate-limiter.js';
import {
  deleteAvatar,
  requireDomainUserId,
  resolveAvatar,
  uploadAvatar,
} from '../../services/avatar.service.js';
import { normalizeDomain } from '../../utils/domain.js';
import {
  AVATAR_UPLOAD_BODY_LIMIT,
  AvatarImageQueryFields,
  avatarUploadResponse,
  configDefaultAvatarStyle,
  optionalConfigVerifier,
  readAvatarUpload,
  sendAvatar,
} from '../avatar/shared.js';

const ParamsSchema = z.object({ userId: z.string().trim().min(1).max(200) }).strict();

const ImageQuerySchema = z
  .object({
    domain: z.string().trim().min(1),
    config_url: z.string().trim().min(1).max(2048).optional(),
    ...AvatarImageQueryFields,
  })
  .strict();

const MutationQuerySchema = z.object({ domain: z.string().trim().min(1) }).strict();

// Mutations are keyed per domain + target user so one product backend churning one user's avatar
// cannot exhaust the budget for another user or another domain.
const mutationRateLimit = createRateLimiter({
  keyBuilder: (request: FastifyRequest) => {
    const query = MutationQuerySchema.safeParse(request.query);
    const params = ParamsSchema.safeParse(request.params);
    const domain = query.success ? normalizeDomain(query.data.domain) : 'unknown';
    return `domain-avatar-write:${domain}:${params.success ? params.data.userId : 'unknown'}`;
  },
  limit: 30,
  windowMs: 60 * 60 * 1000,
});

const uploadResponseSchema = { type: 'object', additionalProperties: true } as const;

export function registerDomainUserAvatarRoutes(app: FastifyInstance): void {
  app.get(
    '/domain/users/:userId/avatar',
    { preHandler: [optionalConfigVerifier, requireDomainHashAuthForDomainQuery] },
    async (request, reply) => {
      const { userId } = ParamsSchema.parse(request.params);
      const query = ImageQuerySchema.parse(request.query);
      const domain = normalizeDomain(query.domain);

      const resolvedUserId = await requireDomainUserId({ domain, userId });
      const avatar = await resolveAvatar({
        userId: resolvedUserId,
        style: query.style ?? null,
        configDefaultStyle: configDefaultAvatarStyle(request, domain),
        size: query.size ?? null,
      });

      return sendAvatar(request, reply, avatar);
    },
  );

  app.put(
    '/domain/users/:userId/avatar',
    {
      bodyLimit: AVATAR_UPLOAD_BODY_LIMIT,
      preHandler: [requireDomainHashAuthForDomainQuery, mutationRateLimit],
      schema: { response: { 200: uploadResponseSchema } },
    },
    async (request) => {
      const { userId } = ParamsSchema.parse(request.params);
      const { domain } = MutationQuerySchema.parse(request.query);

      const resolvedUserId = await requireDomainUserId({ domain, userId });
      const data = await readAvatarUpload(request);

      return avatarUploadResponse(await uploadAvatar({ userId: resolvedUserId, data }));
    },
  );

  app.delete(
    '/domain/users/:userId/avatar',
    {
      preHandler: [requireDomainHashAuthForDomainQuery, mutationRateLimit],
      schema: { response: { 200: uploadResponseSchema } },
    },
    async (request) => {
      const { userId } = ParamsSchema.parse(request.params);
      const { domain } = MutationQuerySchema.parse(request.query);

      const resolvedUserId = await requireDomainUserId({ domain, userId });
      await deleteAvatar({ userId: resolvedUserId });

      return { ok: true };
    },
  );
}
