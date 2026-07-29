import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { requireAdminSuperuser } from '../../../middleware/admin-superuser.js';
import { createRateLimiter } from '../../../middleware/rate-limiter.js';
import { writeAuditLog } from '../../../services/audit-log.service.js';
import {
  deleteTeamAvatar,
  requireTeamContext,
  resolveTeamAvatar,
  uploadTeamAvatar,
} from '../../../services/team-avatar.service.js';
import { AppError } from '../../../utils/errors.js';
import {
  AVATAR_UPLOAD_BODY_LIMIT,
  AvatarImageQueryFields,
  avatarUploadResponse,
  readAvatarUpload,
  sendAvatar,
} from '../../avatar/shared.js';

/**
 * Team ("company") avatars for the Admin panel (Docs/Auth/avatars.md §11). Admin superuser bearer,
 * any team, same resolution pipeline as the product-facing routes. The mutations are audit-logged
 * against the owning domain, like the other `/internal/admin/*` mutations.
 */

const TeamParamsSchema = z.object({ teamId: z.string().trim().min(1) });
const AvatarQuerySchema = z.object({ ...AvatarImageQueryFields }).strict();
const uploadResponseSchema = { type: 'object', additionalProperties: true } as const;

const mutationRateLimit = createRateLimiter({
  keyBuilder: (request: FastifyRequest) => {
    const params = TeamParamsSchema.safeParse(request.params);
    return `admin:team-avatar-write:${params.success ? params.data.teamId : 'unknown'}`;
  },
  limit: 30,
  windowMs: 60 * 60 * 1000,
});

function requireActorEmail(request: { adminAccessTokenClaims?: { email: string } }): string {
  const email = request.adminAccessTokenClaims?.email;
  if (!email) throw new AppError('INTERNAL', 500, 'MISSING_ADMIN_CLAIMS');
  return email;
}

export function registerInternalAdminTeamRoutes(app: FastifyInstance): void {
  // Image bytes for any team. No response schema: this returns an image, not JSON.
  app.get(
    '/internal/admin/teams/:teamId/avatar',
    { preHandler: [requireAdminSuperuser] },
    async (request, reply) => {
      const { teamId } = TeamParamsSchema.parse(request.params);
      const query = AvatarQuerySchema.parse(request.query);

      const avatar = await resolveTeamAvatar({
        teamId,
        style: query.style ?? null,
        size: query.size ?? null,
      });

      return sendAvatar(request, reply, avatar);
    },
  );

  app.put(
    '/internal/admin/teams/:teamId/avatar',
    {
      bodyLimit: AVATAR_UPLOAD_BODY_LIMIT,
      preHandler: [requireAdminSuperuser, mutationRateLimit],
      schema: { response: { 200: uploadResponseSchema } },
    },
    async (request) => {
      const { teamId } = TeamParamsSchema.parse(request.params);
      const actorEmail = requireActorEmail(request);

      const context = await requireTeamContext(teamId);
      const data = await readAvatarUpload(request);
      const result = await uploadTeamAvatar({ teamId: context.teamId, data });

      await writeAuditLog({
        actorEmail,
        action: 'team.avatar_updated',
        targetDomain: context.domain,
        metadata: {
          teamId: context.teamId,
          orgId: context.orgId,
          contentType: result.contentType,
          sizeBytes: result.sizeBytes,
        },
      });

      return avatarUploadResponse(result);
    },
  );

  app.delete(
    '/internal/admin/teams/:teamId/avatar',
    {
      preHandler: [requireAdminSuperuser, mutationRateLimit],
      schema: { response: { 200: uploadResponseSchema } },
    },
    async (request) => {
      const { teamId } = TeamParamsSchema.parse(request.params);
      const actorEmail = requireActorEmail(request);

      const context = await requireTeamContext(teamId);
      await deleteTeamAvatar({ teamId: context.teamId });

      await writeAuditLog({
        actorEmail,
        action: 'team.avatar_deleted',
        targetDomain: context.domain,
        metadata: { teamId: context.teamId, orgId: context.orgId },
      });

      return { ok: true };
    },
  );
}
