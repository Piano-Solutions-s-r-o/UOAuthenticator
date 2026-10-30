import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { configVerifier } from '../../middleware/config-verifier.js';
import { requireSameOriginBrowserRequest } from '../../middleware/same-origin-browser.js';
import { AppError, isAppError } from '../../utils/errors.js';
import { recordAuthFunnelStep } from '../../services/auth-funnel.service.js';
import {
  validateVerifyEmailToken,
  verifyEmailToken,
  type VerifyEmailTokenReference,
} from '../../services/auth-verify-email.service.js';
import {
  emailAuthMethod,
  emailContinuationResponse,
  resolveEmailContinuation,
} from '../../services/email-continuation.service.js';
import { parseRequestAccessFlag } from '../../services/access-request-flow.service.js';
import { parseRequiredPkceChallenge } from '../../utils/pkce.js';
import { tokenConsumeRateLimiter } from './rate-limit-keys.js';
import { assertPendingRegistrationCompletion } from '../../services/pending-registration.service.js';
import {
  clearRegistrationHandoffCookie,
  resolveRegistrationHandoff,
} from '../../services/registration-handoff.service.js';
import { isRegistrationFlowEnabled } from './registration-context.js';

function setPasswordFailureOutcome(err: unknown): string {
  const message = isAppError(err) ? err.message : '';
  if (message === 'PASSWORD_POLICY_VIOLATION' || message === 'MISSING_PASSWORD') {
    return 'password_rejected';
  }
  if (message === 'TOKEN_EXPIRED') return 'expired';
  if (message === 'TOKEN_ALREADY_USED' || message === 'USER_ALREADY_HAS_PASSWORD') return 'already_used';
  return 'failed';
}

const BodySchema = z
  .object({
    token: z.string().min(1).max(4096),
    password: z.string().min(1).max(1024).optional(),
  })
  .strict();

// HUGO-2261: a browser that opened a registration link holds no token; the handoff cookie names
// the registration and the server resolves its token. Only a product on that flow accepts this.
const HandoffBodySchema = BodySchema.partial({ token: true });

const QuerySchema = z
  .object({
    config_url: z.string().min(1).max(2048),
    redirect_url: z.string().min(1).max(2048).optional(),
    code_challenge: z.string().min(1).max(256).optional(),
    code_challenge_method: z.string().min(1).max(32).optional(),
    request_access: z.string().max(16).optional(),
  })
  .strict();

export function registerAuthVerifyEmailRoute(app: FastifyInstance): void {
  // Completes registration email verification. For password-required mode, a password is
  // required; for passwordless mode, token consumption signs the user in directly.
  app.post(
    '/auth/verify-email',
    {
      preHandler: [tokenConsumeRateLimiter, configVerifier],
    },
    async (request, reply) => {
      const config = request.config;
      const configUrl = request.configUrl;
      if (!config || !configUrl) {
        throw new AppError('BAD_REQUEST', 400, 'MISSING_CONFIG');
      }
      const { token, password } = (
        isRegistrationFlowEnabled(config) ? HandoffBodySchema : BodySchema
      ).parse(request.body);
      const { redirect_url, code_challenge, code_challenge_method, request_access } =
        QuerySchema.parse(request.query);
      const pkce = parseRequiredPkceChallenge({
        codeChallenge: code_challenge,
        codeChallengeMethod: code_challenge_method,
      });
      const requestAccess = parseRequestAccessFlag(request_access);

      let reference: VerifyEmailTokenReference;
      if (token) {
        await assertPendingRegistrationCompletion(
          {
            token,
            cookies: request.cookies,
            config,
            configUrl,
            redirectUrl: redirect_url,
            requestAccess,
            ...pkce,
          },
          request.adminDb,
        );
        reference = { token };
      } else {
        await requireSameOriginBrowserRequest(request);
        const handoff = await resolveRegistrationHandoff(
          { request, config, configUrl },
          request.adminDb,
        );
        if (!handoff) throw new AppError('BAD_REQUEST', 400, 'REGISTRATION_UNAVAILABLE');
        reference = { tokenHash: handoff.tokenHash };
      }

      const recordSetPassword = (outcome: string) =>
        recordAuthFunnelStep(
          { domain: config.domain, step: 'set_password', outcome },
          { prisma: request.adminDb },
        );

      const verified = await (async () => {
        const tokenType = await validateVerifyEmailToken(
          {
            ...reference,
            config,
            configUrl,
          },
          { prisma: request.adminDb },
        );

        if (tokenType === 'VERIFY_EMAIL_SET_PASSWORD' && !password) {
          throw new AppError('BAD_REQUEST', 400, 'MISSING_PASSWORD');
        }

        return verifyEmailToken(
          {
            ...reference,
            password,
            config,
            configUrl,
          },
          { prisma: request.adminDb },
        );
      })().catch(async (err: unknown) => {
        await recordSetPassword(setPasswordFailureOutcome(err));
        throw err;
      });
      if (!token) clearRegistrationHandoffCookie(reply);
      const { userId, credentialEpoch, type, twoFaEnabled, acceptedInvite } = verified;
      // Only set-password tokens create password accounts. Browser-authorized
      // registration can also continue an existing-account or passwordless proof.
      await recordSetPassword(
        type === 'VERIFY_EMAIL_SET_PASSWORD' ? 'succeeded' : `succeeded_${type.toLowerCase()}`,
      );

      const authMethod = emailAuthMethod(type);
      const continuation = await resolveEmailContinuation(
        {
          userId,
          credentialEpoch,
          twoFaEnabled,
          acceptedInvite,
          authMethod,
          config,
          configUrl,
          requestedRedirectUrl: redirect_url,
          requestAccess,
          codeChallenge: pkce.codeChallenge,
          codeChallengeMethod: pkce.codeChallengeMethod,
          ip: request.ip ?? null,
        },
        request.adminDb,
      );

      reply.status(200).send(
        await emailContinuationResponse(continuation, {
          request,
          domain: config.domain,
          userId,
          authMethod,
        }),
      );
    },
  );
}
