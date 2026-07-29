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
  recordDomainAvatarAudit,
  sendAvatar,
} from '../avatar/shared.js';

/**
 * `/domain/users/:userId/avatar` — a product backend managing one of its users' avatars.
 *
 * ### Accepted risk: a `global`-scope user has ONE avatar, shared by every domain
 *
 * `user_avatars` is keyed on `user_id` alone, and a `global`-scope user (`User.domain === null`,
 * `user_key` = email) is a single row shared by every domain that user belongs to. So a `PUT` here
 * from domain A replaces the image that domain B renders for the same person. This is deliberate
 * and not a bug to patch here: the shared identity IS the product — a global user has one email,
 * one password, one 2FA secret and one profile across every integration, and per-domain avatars
 * would be a schema/brief change (a scoped key, a scope selector on the API, resolution fallback),
 * not a route fix. It is also not open: the caller must hold the domain-hash bearer, which is full
 * system trust for its domain (brief §24.10), AND `requireDomainUserId` requires the target user to
 * hold a `DomainRole` in that same domain — so only a domain the user actually joined can write.
 *
 * What was genuinely missing is traceability, and that is fixed: every mutation below writes an
 * `AdminAuditLog` row naming the acting domain, so a cross-tenant overwrite is attributable rather
 * than anonymous. If per-domain avatars are ever wanted, that belongs in `Docs/Auth/avatars.md`
 * and a migration, not in a guard bolted onto this route.
 */

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
    // Auth first, config second: `optionalConfigVerifier` does attacker-directed outbound work, so
    // it must never run for a caller that is about to get a 401. See `optionalConfigVerifier`.
    { preHandler: [requireDomainHashAuthForDomainQuery, optionalConfigVerifier] },
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
      const result = await uploadAvatar({ userId: resolvedUserId, data });

      await recordDomainAvatarAudit(request, {
        action: 'domain.user_avatar_updated',
        domain,
        metadata: {
          userId: resolvedUserId,
          contentType: result.contentType,
          sizeBytes: result.sizeBytes,
        },
      });

      return avatarUploadResponse(result);
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

      await recordDomainAvatarAudit(request, {
        action: 'domain.user_avatar_deleted',
        domain,
        metadata: { userId: resolvedUserId },
      });

      return { ok: true };
    },
  );
}
