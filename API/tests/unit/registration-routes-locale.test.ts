import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { REGISTRATION_EMAIL_TOKEN_TTL_MS } from '../../src/config/constants.js';

const mocks = vi.hoisted(() => ({ start: vi.fn(), funnel: vi.fn() }));
vi.mock('../../src/config/env.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/config/env.js')>(),
  getPublicBaseUrl: () => 'https://auth.example.com',
}));
vi.mock('../../src/services/pending-registration.service.js', () => ({
  startPendingRegistration: mocks.start,
  pendingRegistrationState: vi.fn(),
  verifyPendingRegistrationCode: vi.fn(),
  openPendingRegistrationLink: vi.fn(),
  continuePendingRegistration: vi.fn(),
}));
vi.mock('../../src/services/auth-funnel.service.js', () => ({ recordAuthFunnelStep: mocks.funnel }));
vi.mock('../../src/routes/auth/registration-context.js', () => ({
  registrationContext: () => ({ config: { domain: 'client.example.com' }, configUrl: 'https://client.example.com/config' }),
}));
import { registerPendingRegistrationRoutes } from '../../src/routes/auth/registration.js';

type Handler = (request: unknown, reply: unknown) => Promise<unknown>;

function routes() {
  const handlers = new Map<string, Handler>();
  const app = {
    get: (path: string, _options: unknown, handler?: Handler) => { handlers.set(`GET ${path}`, handler ?? (_options as Handler)); },
    post: (path: string, _options: unknown, handler: Handler) => { handlers.set(`POST ${path}`, handler); },
  };
  registerPendingRegistrationRoutes(app as unknown as FastifyInstance);
  return handlers;
}

function reply() {
  const headers: Record<string, string> = {};
  const state = { cookie: undefined as undefined | { name: string; options: Record<string, unknown> }, body: '', type: '' };
  const object = {
    header: (name: string, value: string) => { headers[name] = value; return object; },
    setCookie: (name: string, _value: string, options: Record<string, unknown>) => { state.cookie = { name, options }; return object; },
    code: () => object,
    type: (value: string) => { state.type = value; return object; },
    send: (value: string) => { state.body = value; return object; },
  };
  return { object, headers, state };
}

beforeEach(() => {
  mocks.start.mockReset();
  mocks.funnel.mockReset();
  mocks.start.mockResolvedValue({
    id: '9466e365-206c-49cb-a8d5-aa1342bdd613', credential: 'c', expiresAt: new Date(0), status: 'sent', delivery: 'verification_sent',
  });
});

describe('registration start', () => {
  const start = () => routes().get('POST /auth/registration/start')!;

  it('writes the email in the language of the start request and falls back to English', async () => {
    for (const [header, locale] of [['cs-CZ,cs;q=0.9,en;q=0.8', 'cs'], ['en-GB', 'en'], ['de-DE', 'en'], [undefined, 'en']] as const) {
      mocks.start.mockClear();
      await start()({ body: { email: 'a@b.cz' }, headers: { 'accept-language': header }, adminDb: {}, ip: '127.0.0.1' }, reply().object);
      expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({ email: 'a@b.cz', locale }), {});
    }
  });

  it('keeps the HttpOnly registration cookie as long as the registration lasts', async () => {
    const answer = reply();
    await start()({ body: { email: 'a@b.cz' }, headers: {}, adminDb: {}, ip: '127.0.0.1' }, answer.object);
    expect(answer.state.cookie?.options).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/auth', maxAge: REGISTRATION_EMAIL_TOKEN_TTL_MS / 1000 });
  });
});

describe('registration link page', () => {
  const page = () => routes().get('GET /auth/registration/link')!;

  it('is Czech for a Czech GET and keeps the isolation headers and nonce', async () => {
    const answer = reply();
    await page()({ headers: { 'accept-language': 'cs' } }, answer.object);
    expect(answer.state.body).toContain('<html lang="cs">');
    const nonce = /script-src 'nonce-([0-9a-f]{32})'/.exec(answer.headers['Content-Security-Policy'] ?? '')?.[1];
    expect(nonce).toBeTruthy();
    expect(answer.state.body).toContain(`<script nonce="${nonce}">`);
    expect(answer.headers['Content-Language']).toBe('cs');
    expect(answer.headers.Vary).toBe('Accept-Language');
    expect(answer.state.type).toBe('text/html; charset=utf-8');
    expect(answer.headers['Referrer-Policy']).toBe('no-referrer');
    expect(answer.headers['Cache-Control']).toBe('no-store');
    expect(answer.headers['Content-Security-Policy']).toContain("default-src 'none'");
    expect(answer.headers['Set-Cookie']).toBeUndefined();
  });

  it('is English without an Accept-Language header', async () => {
    const answer = reply();
    await page()({ headers: {} }, answer.object);
    expect(answer.state.body).toContain('<html lang="en">');
  });
});
