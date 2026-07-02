import type { FastifyInstance } from 'fastify';

import { getEnv } from '../config/env.js';
import { buildPublicErrorBody } from '../utils/error-response.js';

export function registerAppleDomainAssociationRoute(app: FastifyInstance): void {
  app.get('/.well-known/apple-developer-domain-association.txt', async (_request, reply) => {
    const association = getEnv().APPLE_DOMAIN_ASSOCIATION?.trim();
    if (!association) {
      reply.status(404).send(buildPublicErrorBody({ statusCode: 404 }));
      return;
    }

    reply.header('Cache-Control', 'public, max-age=300');
    reply.type('text/plain; charset=utf-8').send(association);
  });
}
