import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mailbox = vi.hoisted(() => ({ messages: [] as Array<{ to: string; link: string; code: string }> }));
vi.mock('../../src/services/email.service.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/services/email.service.js')>(),
  sendRegistrationVerificationEmail: async (message: { to: string; link: string; code: string }) => { mailbox.messages.push(message); },
}));
vi.mock('../../src/services/ban-policy.service.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/services/ban-policy.service.js')>(),
  isPrincipalBannedForRegistration: async () => false,
}));

import { registrationCookieName } from '../../src/services/registration-credentials.js';
import { buildUserIdentity } from '../../src/services/user-scope.service.js';
import {
  challengeB, createRegistrationHarness, flowQuery, handoffCookie, loginRestartUrl, noRestartConfigUrl,
  offConfigUrl, origin, peer, queryA, queryB, registrationRestartUrl, type Flow, type RegistrationHarness,
} from '../helpers/pending-registration-harness.js';

// The DB-less CI step runs every test file; DB-backed files skip themselves without DATABASE_URL.
describe.skipIf(!process.env.DATABASE_URL)('browser-bound pending registration', () => {
  let h: RegistrationHarness;
  const noLoginRestartConfigUrl = 'https://client.example.com/auth-config-no-login-restart';

  beforeAll(async () => {
    h = await createRegistrationHarness(mailbox, { [noLoginRestartConfigUrl]: { login_restart_url: undefined } });
    await h.db.prisma.authFunnelDailyCount.deleteMany();
  });
  beforeEach(() => { mailbox.messages.length = 0; });
  afterAll(async () => { await h?.close(); });

  const row = (flow: Flow) => h.db.prisma.pendingRegistration.findUniqueOrThrow({ where: { id: flow.id } });

  it.each([['opted out', offConfigUrl], ['opted in without a registration restart URL', noRestartConfigUrl]])(
    'refuses every browser-bound endpoint, without a row or an email, when the product is %s', async (_name, url) => {
      const off = flowQuery(undefined, url);
      const unknown = '00000000-0000-4000-8000-000000000000';
      const before = await h.db.prisma.pendingRegistration.count();
      const started = await h.app.inject({ method: 'POST', url: `/auth/registration/start?${off}`, payload: { email: 'off@example.com' },
        headers: { origin, 'x-forwarded-for': '192.0.2.200' } });
      expect(started.statusCode).toBe(400);
      expect(started.json().code).toBe('REGISTRATION_UNAVAILABLE');
      expect(started.headers['set-cookie']).toBeUndefined();
      expect(mailbox.messages).toHaveLength(0);
      expect(await h.db.prisma.pendingRegistration.count()).toBe(before);
      expect((await h.app.inject({ method: 'GET', url: `/auth/registration/status?${off}&id=${unknown}`, headers: { origin } })).statusCode).toBe(400);
      expect((await h.app.inject({ method: 'POST', url: `/auth/registration/code?${off}`, payload: { id: unknown, code: 'AB3K7M' },
        headers: { origin, 'x-forwarded-for': '192.0.2.201' } })).statusCode).toBe(400);
      expect((await h.app.inject({ method: 'POST', url: `/auth/registration/continue?${off}`, payload: { id: unknown },
        headers: { origin, 'x-forwarded-for': '192.0.2.202' } })).statusCode).toBe(400);
      await expect(h.app.injectWS(`/auth/registration/events?${off}&id=${unknown}`, { headers: { origin }, socket: peer })).rejects.toThrow('Unexpected server response: 400');
    });

  it('keeps the original token requirement on /auth/verify-email for a product that is off', async () => {
    const response = await h.finish('', flowQuery(challengeB, offConfigUrl));
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBeUndefined();
  });

  it('counts the first open and a replay, and approves nothing either time', async () => {
    const flow = await h.start();
    const first = await h.link(flow);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toEqual({ status: 'continue', next: registrationRestartUrl });
    expect(first.headers.location).toBeUndefined();
    const again = await h.link(flow);
    expect(again.json()).toEqual({ status: 'continue', next: registrationRestartUrl });
    expect((await h.status(flow)).json()).toEqual({ status: 'pending' });
    const stored = await row(flow);
    expect(stored.browserAuthorizedAt).toBeNull();
    expect(stored.emailVerifiedAt).toBeNull();
    expect(stored.linkUsedAt).not.toBeNull();
    expect(await h.db.prisma.user.count({ where: { email: flow.email } })).toBe(0);
    const counts = await h.db.prisma.authFunnelDailyCount.findMany({ where: { step: 'email_link_opened', domain: 'client.example.com' } });
    expect(counts).toEqual(expect.arrayContaining([
      expect.objectContaining({ outcome: 'opened', count: 1 }),
      expect.objectContaining({ outcome: 'already_used', count: 1 }),
    ]));
  });

  it('sets a host-only, signed, HttpOnly, Lax handoff cookie holding no secret or address', async () => {
    const flow = await h.start();
    const header = handoffCookie(await h.link(flow));
    expect(header).toMatch(/; HttpOnly/i);
    expect(header).toMatch(/; SameSite=Lax/i);
    expect(header).toMatch(/; Path=\/auth(;|$)/i);
    expect(header).not.toMatch(/; Domain=/i);
    expect(Number(/Max-Age=(\d+)/i.exec(header)?.[1])).toBe(3600);
    const value = decodeURIComponent(header.split(';')[0].split('=').slice(1).join('='));
    expect(value.startsWith(`${flow.id}.`)).toBe(true);
    expect(value).not.toContain(flow.email);
    expect(value).not.toContain(new URL(flow.message.link).hash.slice(1));
    expect(value.split('.').length).toBe(4); // id, issued-at, expiry, signature
  });

  it('never lets the handoff cookie outlive the registration', async () => {
    const flow = await h.start();
    await h.db.prisma.pendingRegistration.update({ where: { id: flow.id }, data: { expiresAt: new Date(Date.now() + 60_000) } });
    const maxAge = Number(/Max-Age=(\d+)/i.exec(handoffCookie(await h.link(flow)))?.[1]);
    expect(maxAge).toBeGreaterThan(0);
    expect(maxAge).toBeLessThanOrEqual(60);
  });

  it('lets a mail scanner GET and HEAD the link without using anything', async () => {
    const flow = await h.start();
    const before = await h.db.prisma.authFunnelDailyCount.findMany({ where: { step: 'email_link_opened', domain: 'client.example.com' } });
    const get = await h.app.inject({ method: 'GET', url: '/auth/registration/link' });
    const head = await h.app.inject({ method: 'HEAD', url: '/auth/registration/link' });
    expect(get.statusCode).toBe(200);
    expect(head.statusCode).toBe(200);
    expect(get.headers['set-cookie']).toBeUndefined();
    expect((await row(flow)).linkUsedAt).toBeNull();
    expect((await h.status(flow)).json()).toEqual({ status: 'pending' });
    expect(await h.db.prisma.authFunnelDailyCount.findMany({ where: { step: 'email_link_opened', domain: 'client.example.com' } })).toEqual(before);
  });

  it('serves an isolated page that takes the secret out of the address and posts it at once', async () => {
    const result = await h.app.inject({ method: 'GET', url: '/auth/registration/link' });
    expect(result.body).toContain('Opening Hugo…');
    expect(result.body).toContain('history.replaceState');
    expect(result.body).not.toContain('<img');
    expect(result.headers['referrer-policy']).toBe('no-referrer');
    expect(result.headers['content-security-policy']).toContain("default-src 'none'");
  });

  it('answers an unknown or malformed token with 400 and no cookie', async () => {
    const unknown = await h.app.inject({ method: 'POST', url: '/auth/registration/link', payload: { token: 'a'.repeat(43) }, headers: { origin, 'x-forwarded-for': '198.51.100.1' } });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.headers['set-cookie']).toBeUndefined();
    const malformed = await h.app.inject({ method: 'POST', url: '/auth/registration/link', payload: { token: 'short' }, headers: { origin, 'x-forwarded-for': '198.51.100.1' } });
    expect(malformed.statusCode).toBe(400);
  });

  it('sends an expired or exhausted link back to registration, with no cookie', async () => {
    const expired = await h.start();
    await h.db.prisma.pendingRegistration.update({ where: { id: expired.id }, data: { expiresAt: new Date(0) } });
    const exhausted = await h.start();
    await h.db.prisma.pendingRegistration.update({ where: { id: exhausted.id }, data: { attempts: 5 } });
    for (const flow of [expired, exhausted]) {
      const result = await h.link(flow);
      expect(result.statusCode).toBe(200);
      expect(result.json()).toEqual({ status: 'expired', next: registrationRestartUrl });
      expect(result.headers['set-cookie']).toBeUndefined();
    }
  });

  it('sends the link of an existing account to sign-in: it has no password to set', async () => {
    const email = `existing-${Date.now()}@example.com`;
    const { userKey, domain } = buildUserIdentity({ userScope: 'global', email, domain: 'client.example.com' });
    await h.db.prisma.user.create({ data: { email, userKey, domain, passwordHash: 'stored-hash' } });
    const flow = await h.start(email);
    const result = await h.link(flow);
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ status: 'complete', next: loginRestartUrl });
    expect(result.headers['set-cookie']).toBeUndefined();
    expect((await h.status(flow)).json()).toEqual({ status: 'pending' }); // Its code still works.
    expect((await h.code(flow)).json()).toMatchObject({ status: 'authorized', token_type: 'LOGIN_LINK' });
  });

  it('answers complete without a next step when the product has no login restart URL', async () => {
    const flow = await h.start(undefined, flowQuery(undefined, noLoginRestartConfigUrl));
    const { userKey, domain } = buildUserIdentity({ userScope: 'global', email: flow.email, domain: 'client.example.com' });
    await h.db.prisma.user.create({ data: { email: flow.email, userKey, domain, passwordHash: 'stored-hash' } });
    expect((await h.link(flow)).json()).toEqual({ status: 'complete' });
  });

  it('accepts the code only in the requesting browser and exact context', async () => {
    const flow = await h.start();
    expect((await h.code(flow, flow.message.code, '')).statusCode).toBe(400);
    expect((await h.code(flow, flow.message.code, flow.cookie, queryB)).statusCode).toBe(400);
    const accepted = await h.code(flow);
    expect(accepted.json()).toMatchObject({ status: 'authorized', token_type: 'VERIFY_EMAIL_SET_PASSWORD' });
    expect(accepted.json().token).toMatch(/^registration\./);
    expect((await h.status(flow)).json()).toMatchObject({ status: 'authorized' }); // refresh recovery
    expect((await h.status(flow, '')).statusCode).toBe(400);
    expect((await row(flow)).linkUsedAt).toBeNull(); // A code is not a link open.
  });

  it('holds a copied completion proof to the original cookie', async () => {
    const flow = await h.start();
    const proof = (await h.code(flow)).json().token as string;
    const copied = await h.app.inject({ method: 'POST', url: `/auth/verify-email?${queryA}`,
      payload: { token: proof, password: 'a-strong-password-123' }, headers: { origin } });
    expect(copied.statusCode).toBe(400);
    expect(copied.json().code).toBe('REGISTRATION_UNAVAILABLE');
  });

  it('persists at most five guesses across concurrent requests', async () => {
    const flow = await h.start();
    const attempts = await Promise.all(Array.from({ length: 5 }, () => h.code(flow, '!!!!!!')));
    expect(attempts.every(result => result.statusCode === 400)).toBe(true);
    expect((await row(flow)).attempts).toBe(5);
    expect((await h.code(flow)).statusCode).toBe(400);
    expect((await h.status(flow)).json()).toEqual({ status: 'expired' });
  });

  it('keeps the browser secret only for a real resend', async () => {
    const secret = (cookie: string) => cookie.split('=')[1];
    const first = await h.start();
    expect(secret((await h.resend(first)).cookie)).toBe(secret(first.cookie));
    let n = 0;
    const attempt = async (email: string, cookie: string, url = queryA) => {
      n += 1;
      const response = await h.app.inject({ method: 'POST', url: `/auth/registration/start?${url}`, payload: { email, previous_id: first.id },
        headers: { origin, cookie, 'x-forwarded-for': `203.0.113.${n}` } });
      expect(response.statusCode, response.body).toBe(200);
      return secret(String(response.headers['set-cookie']).split(';')[0]);
    };
    expect(await attempt(`other-${first.id}@example.com`, first.cookie)).not.toBe(secret(first.cookie));
    expect(await attempt(first.email, `${registrationCookieName(first.id)}=not-the-secret`)).not.toBe('not-the-secret');
    expect(await attempt(first.email, first.cookie, queryB)).not.toBe(secret(first.cookie));
  });

  it('leaves the newer registration waiting when an older link has expired', async () => {
    const first = await h.start();
    const second = await h.resend(first);
    await h.db.prisma.pendingRegistration.update({ where: { id: first.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await h.link(first)).json().status).toBe('expired');
    expect((await h.status(second)).json()).toEqual({ status: 'pending' });
  });

  it('hints at a code accepted in another tab, with nothing secret in the message', async () => {
    const flow = await h.start();
    let resolveMessage!: (value: string) => void;
    const message = new Promise<string>(resolve => { resolveMessage = resolve; });
    const socket = await h.app.injectWS(`/auth/registration/events?${queryA}&id=${flow.id}`, {
      headers: { cookie: flow.cookie, origin }, socket: peer,
    }, { onInit: client => { client.on('message', value => resolveMessage(String(value))); } });
    expect((await h.code(flow)).statusCode).toBe(200);
    expect(JSON.parse(await message)).toEqual({ type: 'registration.changed' });
    socket.close();
  });

  it('refuses unauthenticated websocket upgrades and cross-origin subscriptions', async () => {
    const flow = await h.start();
    await expect(h.app.injectWS(`/auth/registration/events?${queryA}&id=${flow.id}`, { headers: { origin }, socket: peer })).rejects.toThrow('Unexpected server response: 400');
    await expect(h.app.injectWS(`/auth/registration/events?${queryA}&id=${flow.id}`, { headers: { origin: 'https://evil.example', cookie: flow.cookie }, socket: peer })).rejects.toThrow('Unexpected server response: 403');
  });
});
