import { randomBytes } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { getPublicBaseUrl } from '../../config/env.js';
import { configVerifier } from '../../middleware/config-verifier.js';
import { requireSameOriginBrowserRequest } from '../../middleware/same-origin-browser.js';
import { pendingRegistrationState, startPendingRegistration, verifyPendingRegistrationCode, verifyPendingRegistrationLink } from '../../services/pending-registration.service.js';
import { registrationCookieName, REGISTRATION_TTL_MS } from '../../services/registration-credentials.js';
import { registrationLinkPageCsp, renderRegistrationLinkPage } from '../../services/registration-link-page.service.js';
import { resolveEmailLocale } from '../../utils/email-locale.js';
import { registrationCodeRateLimiter, registrationLinkRateLimiter, registrationStartRateLimiter } from './rate-limit-keys.js';
import { registrationContext } from './registration-context.js';
import { recordAuthFunnelStep } from '../../services/auth-funnel.service.js';

const idSchema = z.string().uuid();
const codeBody = z.object({ id: idSchema, code: z.string().max(64) }).strict();

export function registerPendingRegistrationRoutes(app: FastifyInstance): void {
  app.post('/auth/registration/start', {
    preHandler: [requireSameOriginBrowserRequest, registrationStartRateLimiter, configVerifier],
  }, async (request, reply) => {
    const parsed = z.object({ email: z.string().trim().toLowerCase().email() }).strict().safeParse(request.body);
    const context = registrationContext(request);
    await recordAuthFunnelStep({ domain: context.config.domain, step: 'register_submitted', outcome: parsed.success ? 'valid_email' : 'invalid_email' }, { prisma: request.adminDb });
    let result: Awaited<ReturnType<typeof startPendingRegistration>>;
    try {
      result = await startPendingRegistration({ ...context, email: parsed.success ? parsed.data.email : null, ip: request.ip,
        locale: resolveEmailLocale(request.headers['accept-language']) }, request.adminDb);
    } catch (error) {
      await recordAuthFunnelStep({ domain: context.config.domain, step: 'registration_email', outcome: 'error' }, { prisma: request.adminDb });
      throw error;
    }
    const delivery = result.status === 'existing_user' ? 'existing_user_inline' : result.delivery;
    if (delivery) await recordAuthFunnelStep({ domain: context.config.domain, step: 'registration_email', outcome: delivery }, { prisma: request.adminDb });
    reply.header('Cache-Control', 'no-store');
    if (result.status === 'existing_user') return reply.code(409).send({ error: 'Request failed', code: 'EMAIL_ALREADY_REGISTERED' });
    reply.setCookie(registrationCookieName(result.id), result.credential, {
      httpOnly: true, secure: new URL(getPublicBaseUrl()).protocol === 'https:',
      sameSite: 'lax', path: '/auth', maxAge: REGISTRATION_TTL_MS / 1000,
    });
    return { message: 'We sent instructions to your email', registration_id: result.id, expires_at: result.expiresAt.toISOString() };
  });

  app.get('/auth/registration/status', {
    preHandler: [requireSameOriginBrowserRequest, configVerifier],
  }, async (request, reply) => {
    const { id } = z.object({ id: idSchema }).parse(request.query);
    reply.header('Cache-Control', 'no-store');
    return pendingRegistrationState({ ...registrationContext(request), id,
      credential: request.cookies[registrationCookieName(id)] ?? '' }, request.adminDb);
  });

  app.post('/auth/registration/code', {
    preHandler: [requireSameOriginBrowserRequest, registrationCodeRateLimiter, configVerifier],
  }, async (request, reply) => {
    const { id, code } = codeBody.parse(request.body);
    const context = { ...registrationContext(request), id, credential: request.cookies[registrationCookieName(id)] ?? '' };
    await verifyPendingRegistrationCode({ ...context, code: code.toUpperCase() }, request.adminDb);
    reply.header('Cache-Control', 'no-store');
    return pendingRegistrationState(context, request.adminDb);
  });

  app.get('/auth/registration/link', async (request, reply) => {
    // The fork's app has no global nonce hook, so this page owns its nonce: one fresh value per
    // response, the same one in the policy and in the script tag (never empty or undefined).
    const nonce = randomBytes(16).toString('hex');
    const locale = resolveEmailLocale(request.headers['accept-language']);
    reply.header('Cache-Control', 'no-store');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Vary', 'Accept-Language');
    reply.header('Content-Language', locale);
    reply.header('Content-Security-Policy', registrationLinkPageCsp(nonce));
    return reply.type('text/html; charset=utf-8').send(renderRegistrationLinkPage(nonce, locale));
  });
  app.post('/auth/registration/link', {
    preHandler: [requireSameOriginBrowserRequest, registrationLinkRateLimiter],
  }, async (request, reply) => {
    const { token } = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict().parse(request.body);
    await verifyPendingRegistrationLink(token, request.adminDb);
    reply.header('Cache-Control', 'no-store');
    return { status: 'verified' };
  });
}
