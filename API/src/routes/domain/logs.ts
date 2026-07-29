import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { requireDomainHashAuthForDomainQuery } from '../../middleware/domain-hash-auth.js';
import { listLoginLogsForDomain } from '../../services/login-log.service.js';
import { avatarImageBaseUrl, domainAvatarImageUrl } from '../../utils/avatar-url.js';
import { normalizeDomain } from '../../utils/domain.js';

const QuerySchema = z
  .object({
    domain: z.string().trim().min(1),
    limit: z.coerce.number().int().positive().optional(),
  })
  .strict();

export function registerDomainLogsRoute(app: FastifyInstance): void {
  app.get(
    '/domain/logs',
    {
      preHandler: [requireDomainHashAuthForDomainQuery],
    },
    async (request, reply) => {
      const { domain, limit } = QuerySchema.parse(request.query);

      const logs = await listLoginLogsForDomain({ domain, limit });

      // Docs/Auth/avatars.md §9: rows naming a user also carry a fetchable avatar image URL.
      // `user_id` is nullable on log rows (pre-user-resolution failures), and without an id there
      // is no user to render — those rows get `null`.
      const normalizedDomain = normalizeDomain(domain);
      const baseUrl = avatarImageBaseUrl();

      reply.status(200).send({
        ok: true,
        logs: logs.map((l) => ({
          id: l.id,
          user_id: l.userId,
          email: l.email,
          avatar_image_url: l.userId
            ? domainAvatarImageUrl({ baseUrl, domain: normalizedDomain, userId: l.userId })
            : null,
          domain: l.domain,
          timestamp: l.createdAt.toISOString(),
          auth_method: l.authMethod,
          ip: l.ip,
          user_agent: l.userAgent,
        })),
      });
    },
  );
}
