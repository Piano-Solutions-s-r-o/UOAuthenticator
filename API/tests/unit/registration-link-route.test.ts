import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The route is exercised through the real Fastify app, so the global helmet policy and every
// other hook run exactly as in production; only the database is switched off.
vi.mock('../../src/db/prisma.js', () => ({
  getPrisma: vi.fn(() => ({})),
  getAdminPrisma: vi.fn(() => ({})),
  connectPrisma: vi.fn(async () => {}),
  disconnectPrisma: vi.fn(async () => {}),
}));

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = value;
}

describe('GET /auth/registration/link through the real app', () => {
  const saved = {
    SHARED_SECRET: process.env.SHARED_SECRET,
    AUTH_SERVICE_IDENTIFIER: process.env.AUTH_SERVICE_IDENTIFIER,
    CONFIG_JWKS_URL: process.env.CONFIG_JWKS_URL,
    DATABASE_URL: process.env.DATABASE_URL,
  };

  beforeEach(() => {
    process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
    process.env.AUTH_SERVICE_IDENTIFIER = 'uoa-auth-service';
    process.env.CONFIG_JWKS_URL = 'https://auth.example.com/.well-known/jwks.json';
    Reflect.deleteProperty(process.env, 'DATABASE_URL');
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) restoreEnv(key, value);
  });

  async function get(headers: Record<string, string> = {}) {
    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    await app.ready();
    try {
      const first = await app.inject({ method: 'GET', url: '/auth/registration/link', headers });
      const second = await app.inject({ method: 'GET', url: '/auth/registration/link', headers });
      return { first, second };
    } finally {
      await app.close();
    }
  }

  it('sends a non-empty nonce, identical in the policy and the script tag, fresh per response', { timeout: 90_000 }, async () => {
    const { first, second } = await get();
    expect(first.statusCode).toBe(200);
    const policy = first.headers['content-security-policy'];
    expect(typeof policy).toBe('string'); // one header: helmet's global policy does not add a second
    const nonce = /script-src 'nonce-([A-Za-z0-9+/=_-]+)'/.exec(String(policy))?.[1];
    expect(nonce).toBeTruthy();
    expect(nonce).not.toContain('undefined');
    expect(first.body).toContain(`<script nonce="${nonce}">`);
    // Exactly this route's policy: helmet's global script-src 'self' 'unsafe-inline' is not applied.
    expect(policy).toBe(
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
    );
    const otherNonce = /script-src 'nonce-([A-Za-z0-9+/=_-]+)'/.exec(String(second.headers['content-security-policy']))?.[1];
    expect(otherNonce).toBeTruthy();
    expect(otherNonce).not.toBe(nonce);
    expect(second.body).toContain(`<script nonce="${otherNonce}">`);
  });

  it('keeps the isolation headers, sets no cookie and says which language it is', { timeout: 90_000 }, async () => {
    const { first } = await get({ 'accept-language': 'cs-CZ,cs;q=0.9' });
    expect(first.headers['set-cookie']).toBeUndefined();
    expect(first.headers['cache-control']).toBe('no-store');
    expect(first.headers['referrer-policy']).toBe('no-referrer');
    expect(first.headers['content-language']).toBe('cs');
    expect(String(first.headers.vary)).toMatch(/Accept-Language/i);
    expect(first.body).toContain('<html lang="cs">');
  });

  it('is English with Content-Language en when no supported language is asked for', { timeout: 90_000 }, async () => {
    const { first } = await get({ 'accept-language': 'de-DE' });
    expect(first.headers['content-language']).toBe('en');
    expect(first.body).toContain('<html lang="en">');
  });
});
