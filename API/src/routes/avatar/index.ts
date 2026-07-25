import type { FastifyInstance } from 'fastify';

import { registerAvatarMeRoutes } from './me.js';

export function registerAvatarRoutes(app: FastifyInstance): void {
  registerAvatarMeRoutes(app);
}
