import type { FastifyInstance, RouteShorthandOptions } from 'fastify';
import { z } from 'zod';

import { requireAdminSuperuser } from '../../../middleware/admin-superuser.js';
import { resolveAvatar } from '../../../services/avatar.service.js';
import { resetAdminUserTwoFactor } from '../../../services/internal-admin.service.js';
import { AppError } from '../../../utils/errors.js';
import { AvatarImageQueryFields, sendAvatar } from '../../avatar/shared.js';

const UserParamsSchema = z.object({ userId: z.string().trim().min(1) });
const AvatarQuerySchema = z.object({ ...AvatarImageQueryFields }).strict();
const nullableObjectSchema = {
  anyOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }],
} as const;

function adminRoute(responseSchema: Record<string, unknown>): RouteShorthandOptions {
  return {
    preHandler: [requireAdminSuperuser],
    schema: { response: { 200: responseSchema } },
  };
}

function requireActorEmail(request: { adminAccessTokenClaims?: { email: string } }): string {
  const email = request.adminAccessTokenClaims?.email;
  if (!email) throw new AppError('INTERNAL', 500, 'MISSING_ADMIN_CLAIMS');
  return email;
}

export function registerInternalAdminUserRoutes(app: FastifyInstance): void {
  app.post(
    '/internal/admin/users/:userId/2fa/disable',
    adminRoute(nullableObjectSchema),
    async (request) => {
      const { userId } = UserParamsSchema.parse(request.params);
      return resetAdminUserTwoFactor({ userId, actorEmail: requireActorEmail(request) });
    },
  );

  // Image bytes for any user, through the same resolution pipeline as the product-facing routes
  // (Docs/Auth/avatars.md §5). No response schema: this returns an image, not JSON.
  app.get(
    '/internal/admin/users/:userId/avatar',
    { preHandler: [requireAdminSuperuser] },
    async (request, reply) => {
      const { userId } = UserParamsSchema.parse(request.params);
      const query = AvatarQuerySchema.parse(request.query);

      const avatar = await resolveAvatar({
        userId,
        style: query.style ?? null,
        size: query.size ?? null,
      });

      return sendAvatar(request, reply, avatar);
    },
  );
}
