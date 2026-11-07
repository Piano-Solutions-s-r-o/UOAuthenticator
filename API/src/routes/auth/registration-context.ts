import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

import { parseRequestAccessFlag } from '../../services/access-request-flow.service.js';
import type { ClientConfig } from '../../services/config.service.js';
import { AppError } from '../../utils/errors.js';
import { parseRequiredPkceChallenge } from '../../utils/pkce.js';
import type { RegistrationContext } from '../../services/pending-registration.service.js';

const contextQuery = z.object({
  config_url: z.string().min(1).max(2048),
  redirect_url: z.string().min(1).max(2048).optional(),
  code_challenge: z.string().max(256),
  code_challenge_method: z.string().max(32),
  request_access: z.string().max(16).optional(),
});

/**
 * HUGO-2261: on only with both signed claims. Without a place to start registration from an email
 * link there is nothing to send the person to, so the flow behaves as off.
 */
export function isRegistrationFlowEnabled(config: ClientConfig): boolean {
  return config.login_flow?.registration_code_enabled === true && Boolean(config.registration_restart_url);
}

export function registrationContext(request: FastifyRequest): RegistrationContext {
  const query = contextQuery.parse(request.query);
  if (!request.config || !request.configUrl) throw new AppError('BAD_REQUEST', 400, 'MISSING_CONFIG');
  // HUGO-2261: shipped switched off. Every entry point (start, status, code, events) builds its
  // context here, before any row, email or counter, so a product that has not opted in through
  // its signed config gets the same generic refusal the flow itself uses.
  if (!isRegistrationFlowEnabled(request.config)) {
    throw new AppError('BAD_REQUEST', 400, 'REGISTRATION_UNAVAILABLE');
  }
  const pkce = parseRequiredPkceChallenge({ codeChallenge: query.code_challenge, codeChallengeMethod: query.code_challenge_method });
  return {
    config: request.config, configUrl: request.configUrl, redirectUrl: query.redirect_url,
    requestAccess: parseRequestAccessFlag(query.request_access), ...pkce,
  };
}
