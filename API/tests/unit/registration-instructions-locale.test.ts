import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../src/config/env.js';
import type { ClientConfig } from '../../src/services/config.service.js';
import { testUiTheme } from '../helpers/test-config.js';

const sent = vi.hoisted(() => ({ verification: vi.fn(async () => true) }));
vi.mock('../../src/services/email.service.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/services/email.service.js')>(),
  sendRegistrationVerificationEmail: sent.verification,
}));
import { requestRegistrationInstructions } from '../../src/services/auth-register.service.js';

const env = {
  NODE_ENV: 'test', HOST: '127.0.0.1', PORT: 3000, PUBLIC_BASE_URL: 'https://auth.example.com', LOG_LEVEL: 'info',
  SHARED_SECRET: 'test-shared-secret-with-enough-length', AUTH_SERVICE_IDENTIFIER: 'uoa-auth-service',
  DATABASE_URL: 'postgres://example.invalid/db', ACCESS_TOKEN_TTL: '30m', LOG_RETENTION_DAYS: 90,
  AI_TRANSLATION_PROVIDER: 'disabled',
} as unknown as Env;
const config = {
  domain: 'client.example.com', redirect_urls: ['https://client.example.com/oauth/callback'],
  enabled_auth_methods: ['email_password'], ui_theme: testUiTheme(), language_config: 'en', user_scope: 'global',
  allow_registration: true, registration_mode: 'password_required', '2fa_enabled': false, debug_enabled: false,
} as unknown as ClientConfig;

describe('browser-bound registration email', () => {
  it('is sent in the request locale, and the pending deadline is the token deadline', async () => {
    const create = vi.fn(async () => ({ id: 't' }));
    const prisma = { user: { findUnique: vi.fn(async () => null) }, verificationToken: { create } };
    const expiresAt = new Date('2026-10-24T09:00:00.000Z');
    const result = await requestRegistrationInstructions({
      email: 'a@b.cz', config, configUrl: 'https://client.example.com/config', locale: 'cs',
      codeChallenge: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ', codeChallengeMethod: 'S256',
      browserRegistration: { completionToken: 'registration.proof', link: 'https://auth.example.com/auth/registration/link#s', code: 'AB3K7M', expiresAt },
    }, { env, prisma: prisma as never, isPrincipalBannedForRegistration: async () => false });
    expect(result).toEqual({ status: 'sent', delivery: 'verification_sent' });
    expect(sent.verification).toHaveBeenCalledWith(expect.objectContaining({ to: 'a@b.cz', code: 'AB3K7M', locale: 'cs' }));
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ expiresAt, type: 'VERIFY_EMAIL_SET_PASSWORD' }) });
  });
});
