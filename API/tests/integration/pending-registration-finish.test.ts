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

import { REGISTRATION_CONTINUE_TTL_MS } from '../../src/services/registration-credentials.js';
import { REGISTRATION_HANDOFF_COOKIE } from '../../src/services/registration-handoff.service.js';
import {
  challengeA, challengeB, codeOf, configUrl, createRegistrationHarness, flowQuery, loginRestartUrl, offersPassword,
  origin, otherDomainConfigUrl, password, peer, queryA, queryB, registrationRestartUrl, siblingConfigUrl,
  type RegistrationHarness,
} from '../helpers/pending-registration-harness.js';

// HUGO-2261: the person finishes where they clicked, and the original window follows by itself.
describe.skipIf(!process.env.DATABASE_URL)('finishing a registration where the link was opened', () => {
  let h: RegistrationHarness;
  const changingConfigUrl = 'https://client.example.com/auth-config-changing';
  const twoFaConfigUrl = 'https://client.example.com/auth-config-2fa';
  const chooserConfigUrl = 'https://client.example.com/auth-config-chooser';

  beforeAll(async () => {
    h = await createRegistrationHarness(mailbox, {
      [changingConfigUrl]: { language_config: 'en' },
      [twoFaConfigUrl]: { '2fa_enabled': true },
      [chooserConfigUrl]: {
        login_flow: { registration_code_enabled: true, workspace_selection: 'auto' },
        org_features: { enabled: true, allow_user_create_org: true },
      },
    });
  });
  beforeEach(() => { mailbox.messages.length = 0; });
  afterAll(async () => { await h?.close(); });

  const row = (id: string) => h.db.prisma.pendingRegistration.findUniqueOrThrow({ where: { id } });
  const issuedCodes = (email: string) => h.db.prisma.authorizationCode.findMany({ where: { user: { email } }, orderBy: { createdAt: 'asc' } });

  describe('/auth with a handoff', () => {
    it('offers the password form for the address, and never a token', async () => {
      const flow = await h.start();
      const page = await h.auth(await h.open(flow));
      expect(page.statusCode).toBe(200);
      expect(offersPassword(page.body, flow.email)).toBe(true);
      expect(page.body).toContain('Create your password'); // Server-rendered, not only bootstrapped.
      expect(page.body).toContain('type="password"');
      expect(page.body).not.toContain('registration.');
      expect(page.body).not.toContain(new URL(flow.message.link).hash.slice(1));
    });

    it('keeps the restart prompt and no password form on /auth without PKCE (HUGO-1961)', async () => {
      const flow = await h.start();
      const page = await h.auth(await h.open(flow), new URLSearchParams({ config_url: configUrl }));
      expect(page.statusCode).toBe(200);
      expect(page.body).not.toContain('__UOA_REGISTRATION_HANDOFF__');
      expect(page.body).not.toContain('type="password"');
      expect(page.body).toContain('This link is no longer valid. Click Sign in');
    });

    it('wins over prompt=create, which is how the product comes back', async () => {
      const flow = await h.start();
      const page = await h.auth(await h.open(flow), `${queryB}&prompt=create`);
      expect(offersPassword(page.body, flow.email)).toBe(true);
    });

    it('does not count a flow start for the product coming back', async () => {
      const flow = await h.start();
      const cookie = await h.open(flow);
      const counted = () => h.db.prisma.authFunnelDailyCount.aggregate({ _sum: { count: true }, where: { step: 'flow_started', domain: 'client.example.com' } });
      const before = (await counted())._sum.count ?? 0;
      await h.auth(cookie, `${queryB}&prompt=create`);
      expect((await counted())._sum.count ?? 0).toBe(before);
    });

    it.each([
      ['another product domain', () => flowQuery(challengeB, otherDomainConfigUrl).toString()],
      ['another config of the same domain', () => flowQuery(challengeB, siblingConfigUrl).toString()],
      ['no PKCE', () => new URLSearchParams({ config_url: configUrl }).toString()],
      ['a plain PKCE method', () => new URLSearchParams({ config_url: configUrl, code_challenge: challengeB, code_challenge_method: 'plain' }).toString()],
      ['a mid-flow render', () => `${queryB}&twofa_token=abc`],
    ])('ignores the cookie on %s', async (_name, query) => {
      const flow = await h.start();
      const page = await h.auth(await h.open(flow), query());
      expect(page.statusCode).toBe(200);
      expect(page.body).not.toContain('__UOA_REGISTRATION_HANDOFF__');
    });

    it('ignores the cookie when the product changed its config since registration started', async () => {
      const query = flowQuery(challengeA, changingConfigUrl);
      const flow = await h.start(undefined, query);
      const cookie = await h.open(flow);
      await h.setConfig(changingConfigUrl, { language_config: 'cs' });
      const page = await h.auth(cookie, flowQuery(challengeB, changingConfigUrl));
      expect(page.body).not.toContain('__UOA_REGISTRATION_HANDOFF__');
      await h.setConfig(changingConfigUrl, { language_config: 'en' });
    });

    it('ignores a tampered cookie', async () => {
      const flow = await h.start();
      const [name, value] = (await h.open(flow)).split('=');
      const other = await h.start();
      const page = await h.auth(`${name}=${value.replace(flow.id, other.id)}`);
      expect(page.body).not.toContain('__UOA_REGISTRATION_HANDOFF__');
    });

    it('ignores a cookie past its own expiry, which the browser may not have enforced', async () => {
      const flow = await h.start();
      const cookie = await h.open(flow);
      vi.useFakeTimers({ now: Date.now() + 16 * 60 * 1000, toFake: ['Date'] });
      try {
        expect((await h.auth(cookie)).body).not.toContain('__UOA_REGISTRATION_HANDOFF__');
      } finally { vi.useRealTimers(); }
    });

    it('ignores the cookie once another browser created the account', async () => {
      const email = `taken-${Date.now()}@example.com`;
      const here = await h.start(email);
      const there = await h.start(email);
      const cookie = await h.open(here);
      expect((await h.finish(await h.open(there))).statusCode).toBe(200);
      expect((await row(here.id)).completedAt).toBeNull();
      expect((await h.auth(cookie)).body).not.toContain('__UOA_REGISTRATION_HANDOFF__');
      expect((await h.finish(cookie)).statusCode).toBe(400);
    });

    it('ignores the cookie once the registration expired or used up its guesses', async () => {
      const expired = await h.start();
      const expiredCookie = await h.open(expired);
      await h.db.prisma.pendingRegistration.update({ where: { id: expired.id }, data: { expiresAt: new Date(0) } });
      expect((await h.auth(expiredCookie)).body).not.toContain('__UOA_REGISTRATION_HANDOFF__');
      const exhausted = await h.start();
      const exhaustedCookie = await h.open(exhausted);
      await h.db.prisma.pendingRegistration.update({ where: { id: exhausted.id }, data: { attempts: 5 } });
      expect((await h.auth(exhaustedCookie)).body).not.toContain('__UOA_REGISTRATION_HANDOFF__');
    });
  });

  describe('the password in the clicked browser', () => {
    it('finishes without the original cookie, and the code belongs to this browser only', async () => {
      const flow = await h.start();
      const cookie = await h.open(flow);
      const done = await h.finish(cookie);
      expect(done.statusCode, done.body).toBe(200);
      expect(codeOf(done)).toBeTruthy();
      const codes = await issuedCodes(flow.email);
      expect(codes).toHaveLength(1);
      expect(codes[0].codeChallenge).toBe(challengeB);
      expect(codes[0].codeChallenge).not.toBe(challengeA);
      expect(await h.db.prisma.user.count({ where: { email: flow.email } })).toBe(1);
      expect((await row(flow.id)).completedAt).not.toBeNull();
    });

    it('clears the handoff cookie and spends the one verification token', async () => {
      const flow = await h.start();
      const done = await h.finish(await h.open(flow));
      expect(String(done.headers['set-cookie'])).toContain(`${REGISTRATION_HANDOFF_COOKIE}=;`);
      const stored = await row(flow.id);
      const token = await h.db.prisma.verificationToken.findUniqueOrThrow({ where: { tokenHash: stored.completionHash } });
      expect(token.usedAt).not.toBeNull();
      expect(await h.db.prisma.verificationToken.count({ where: { email: flow.email } })).toBe(1);
    });

    it('refuses without a handoff cookie', async () => {
      const response = await h.finish('');
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('REGISTRATION_UNAVAILABLE');
    });

    it('refuses a request from another origin even with the cookie', async () => {
      const flow = await h.start();
      const cookie = await h.open(flow);
      const response = await h.app.inject({ method: 'POST', url: `/auth/verify-email?${queryB}`, payload: { password },
        headers: { origin: 'https://evil.example', cookie, 'x-forwarded-for': '198.51.100.40' } });
      expect(response.statusCode).toBe(403);
      expect(await h.db.prisma.user.count({ where: { email: flow.email } })).toBe(0);
    });

    it('refuses without PKCE and leaves the registration open', async () => {
      const flow = await h.start();
      const cookie = await h.open(flow);
      const response = await h.finish(cookie, new URLSearchParams({ config_url: configUrl }));
      expect(response.statusCode).toBe(400);
      expect(await h.db.prisma.user.count({ where: { email: flow.email } })).toBe(0);
      expect((await h.finish(cookie)).statusCode).toBe(200);
    });

    it('refuses a config other than the one the registration started on', async () => {
      const flow = await h.start();
      const cookie = await h.open(flow);
      const response = await h.finish(cookie, flowQuery(challengeB, siblingConfigUrl));
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('REGISTRATION_UNAVAILABLE');
    });

    it('asks for a password without spending anything', async () => {
      const flow = await h.start();
      const cookie = await h.open(flow);
      const response = await h.finish(cookie, queryB, {});
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('MISSING_PASSWORD');
      expect((await h.finish(cookie)).statusCode).toBe(200);
    });

    it('gives no second session to a replayed link', async () => {
      const flow = await h.start();
      const cookie = await h.open(flow);
      expect((await h.finish(cookie)).statusCode).toBe(200);
      const replay = await h.link(flow);
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual({ status: 'complete', next: loginRestartUrl });
      expect(replay.headers['set-cookie']).toBeUndefined();
      expect((await h.auth(cookie)).body).not.toContain('__UOA_REGISTRATION_HANDOFF__');
      expect((await h.finish(cookie)).statusCode).toBe(400);
      expect(await issuedCodes(flow.email)).toHaveLength(1);
    });

    it('lets the first of two browsers win, and fails the other generically', async () => {
      const flow = await h.start();
      const first = await h.open(flow);
      const second = await h.open(flow);
      expect((await h.finish(first)).statusCode).toBe(200);
      const late = await h.finish(second);
      expect(late.statusCode).toBe(400);
      expect(late.json().code).toBe('REGISTRATION_UNAVAILABLE');
      expect(await h.db.prisma.user.count({ where: { email: flow.email } })).toBe(1);
    });

    it('lets two browsers at the same moment create one account and one code', async () => {
      const flow = await h.start();
      const outcomes = await Promise.all([h.finish(await h.open(flow)), h.finish(await h.open(flow))]);
      expect(outcomes.map(result => result.statusCode).sort()).toEqual([200, 400]);
      expect(await h.db.prisma.user.count({ where: { email: flow.email } })).toBe(1);
      expect(await issuedCodes(flow.email)).toHaveLength(1);
    });

    it('lets a link and a code racing on one registration create one account', async () => {
      const flow = await h.start();
      const cookie = await h.open(flow);
      const proof = (await h.code(flow)).json().token as string;
      const outcomes = await Promise.all([h.finish(cookie), h.finishInWindow(flow, proof)]);
      expect(outcomes.map(result => result.statusCode).sort()).toEqual([200, 400]);
      expect(await h.db.prisma.user.count({ where: { email: flow.email } })).toBe(1);
      expect(await issuedCodes(flow.email)).toHaveLength(1);
    });

    it('lets an older link and a newer code racing create one account, with a generic failure', async () => {
      const first = await h.start();
      const second = await h.resend(first);
      const cookie = await h.open(first);
      const proof = (await h.code(second)).json().token as string;
      const outcomes = await Promise.all([h.finish(cookie), h.finishInWindow(second, proof)]);
      expect(outcomes.map(result => result.statusCode).sort()).toEqual([200, 400]);
      expect(await h.db.prisma.user.count({ where: { email: first.email } })).toBe(1);
    });

    it('fails an open form generically once another browser of the address won', async () => {
      const email = `shared-${Date.now()}@example.com`;
      const here = await h.start(email);
      const there = await h.start(email);
      const proof = (await h.code(here)).json().token as string;
      expect((await h.finish(await h.open(there))).statusCode).toBe(200);
      expect((await h.finishInWindow(here, proof)).statusCode).toBe(400);
      expect((await h.link(here)).json()).toEqual({ status: 'complete', next: loginRestartUrl });
    });
  });

  describe('the resend family', () => {
    it('lets an older link finish the window on the newest registration, spending the older token', async () => {
      const first = await h.start();
      const second = await h.resend(first);
      expect((await h.status(second)).json()).toEqual({ status: 'pending' });
      expect((await h.finish(await h.open(first))).statusCode).toBe(200);
      expect((await h.status(second)).json()).toEqual({ status: 'complete' });
      const tokens = await h.db.prisma.verificationToken.findMany({ where: { email: first.email }, orderBy: { createdAt: 'asc' } });
      expect(tokens.map(token => Boolean(token.usedAt))).toEqual([true, false]);
      const done = await h.continueWindow(second);
      expect(done.statusCode, done.body).toBe(200);
      expect((await issuedCodes(first.email)).map(code => code.codeChallenge)).toEqual([challengeB, challengeA]);
    });

    it('finishes an exhausted sibling too', async () => {
      const first = await h.start();
      const second = await h.resend(first);
      await h.db.prisma.pendingRegistration.update({ where: { id: second.id }, data: { attempts: 5 } });
      expect((await h.finish(await h.open(first))).statusCode).toBe(200);
      expect((await h.status(second)).json()).toEqual({ status: 'complete' });
    });

    it('does not touch another address or browser on the same OAuth URL', async () => {
      const finished = await h.start();
      const otherAddress = await h.start();
      const otherBrowser = await h.start(finished.email);
      expect((await h.finish(await h.open(finished))).statusCode).toBe(200);
      expect((await h.status(finished)).json()).toEqual({ status: 'complete' });
      expect((await h.status(otherAddress)).json()).toEqual({ status: 'pending' });
      expect((await h.status(otherBrowser)).json()).toEqual({ status: 'pending' });
      expect((await row(otherAddress.id)).completedAt).toBeNull();
      expect((await row(otherBrowser.id)).completedAt).toBeNull();
    });

    it('does not treat a resend without the matching cookie as family', async () => {
      const first = await h.start();
      const stranger = await h.app.inject({ method: 'POST', url: `/auth/registration/start?${queryA}`,
        payload: { email: first.email, previous_id: first.id }, headers: { origin, 'x-forwarded-for': '198.51.100.41' } });
      expect((await h.finish(await h.open(first))).statusCode).toBe(200);
      expect((await row(stranger.json().registration_id)).completedAt).toBeNull();
    });
  });

  describe('the original window', () => {
    it('gets a code for its own PKCE, once, and a funnel step', async () => {
      const flow = await h.start();
      expect((await h.finish(await h.open(flow))).statusCode).toBe(200);
      expect((await h.status(flow)).json()).toEqual({ status: 'complete' }); // Polling never carries a code.
      const done = await h.continueWindow(flow);
      expect(done.statusCode, done.body).toBe(200);
      expect(codeOf(done)).toBeTruthy();
      const codes = await issuedCodes(flow.email);
      expect(codes.map(code => code.codeChallenge)).toEqual([challengeB, challengeA]);
      expect((await h.continueWindow(flow)).statusCode).toBe(400);
      expect(await issuedCodes(flow.email)).toHaveLength(2);
      expect(await h.db.prisma.authFunnelDailyCount.findFirst({ where: { step: 'original_window_continued', outcome: 'succeeded' } })).not.toBeNull();
    });

    it('answers complete to a code typed after the password was set elsewhere', async () => {
      const flow = await h.start();
      expect((await h.finish(await h.open(flow))).statusCode).toBe(200);
      const late = await h.code(flow);
      expect(late.statusCode).toBe(200);
      expect(late.json()).toEqual({ status: 'complete' });
      expect((await row(flow.id)).browserAuthorizedAt).toBeNull();
    });

    it('races to one code', async () => {
      const flow = await h.start();
      expect((await h.finish(await h.open(flow))).statusCode).toBe(200);
      const outcomes = await Promise.all([h.continueWindow(flow), h.continueWindow(flow)]);
      expect(outcomes.map(result => result.statusCode).sort()).toEqual([200, 400]);
      expect(await issuedCodes(flow.email)).toHaveLength(2);
    });

    it('gets one continuation across the family, whichever registration asks', async () => {
      const first = await h.start();
      const second = await h.resend(first);
      expect((await h.finish(await h.open(first))).statusCode).toBe(200);
      expect((await h.continueWindow(second)).statusCode).toBe(200);
      expect((await h.continueWindow(first)).statusCode).toBe(400);
    });

    it('refuses without the original cookie', async () => {
      const flow = await h.start();
      const cookie = await h.open(flow);
      expect((await h.finish(cookie)).statusCode).toBe(200);
      expect((await h.continueWindow(flow, '')).statusCode).toBe(400);
      expect((await h.continueWindow(flow, cookie)).statusCode).toBe(400);
      expect((await row(flow.id)).continuedAt).toBeNull();
    });

    it('refuses another PKCE: the code can only belong to the window that started', async () => {
      const flow = await h.start();
      expect((await h.finish(await h.open(flow))).statusCode).toBe(200);
      expect((await h.continueWindow(flow, flow.cookie, queryB)).statusCode).toBe(400);
    });

    it('refuses before completion', async () => {
      const flow = await h.start();
      await h.open(flow);
      await h.code(flow);
      const early = await h.continueWindow(flow);
      expect(early.statusCode).toBe(400);
      expect(early.json().code).toBe('REGISTRATION_UNAVAILABLE');
    });

    it('refuses fifteen minutes after completion', async () => {
      const flow = await h.start();
      expect((await h.finish(await h.open(flow))).statusCode).toBe(200);
      await h.db.prisma.pendingRegistration.update({ where: { id: flow.id },
        data: { completedAt: new Date(Date.now() - REGISTRATION_CONTINUE_TTL_MS - 1000) } });
      expect((await h.continueWindow(flow)).statusCode).toBe(400);
      expect(await issuedCodes(flow.email)).toHaveLength(1);
    });

    it('still works just inside the fifteen minutes', async () => {
      const flow = await h.start();
      expect((await h.finish(await h.open(flow))).statusCode).toBe(200);
      await h.db.prisma.pendingRegistration.update({ where: { id: flow.id },
        data: { completedAt: new Date(Date.now() - REGISTRATION_CONTINUE_TTL_MS + 60_000) } });
      expect((await h.continueWindow(flow)).statusCode).toBe(200);
    });

    it('refuses once the password holder reset their credentials, and stays closed', async () => {
      const flow = await h.start();
      expect((await h.finish(await h.open(flow))).statusCode).toBe(200);
      await h.db.prisma.user.updateMany({ where: { email: flow.email }, data: { tokenVersion: { increment: 1 } } });
      expect((await h.continueWindow(flow)).statusCode).toBe(401);
      expect(await issuedCodes(flow.email)).toHaveLength(1);
    });

    it('refuses when the user is gone', async () => {
      const flow = await h.start();
      expect((await h.finish(await h.open(flow))).statusCode).toBe(200);
      await h.db.prisma.authorizationCode.deleteMany({ where: { user: { email: flow.email } } });
      await h.db.prisma.domainRole.deleteMany({ where: { user: { email: flow.email } } });
      await h.db.prisma.user.deleteMany({ where: { email: flow.email } });
      expect((await h.continueWindow(flow)).statusCode).toBe(400);
    });

    it('has nothing to continue when it finished by itself', async () => {
      const flow = await h.start();
      const proof = (await h.code(flow)).json().token as string;
      const done = await h.finishInWindow(flow, proof);
      expect(done.statusCode, done.body).toBe(200);
      expect((await h.status(flow)).json()).toEqual({ status: 'complete' });
      expect((await h.continueWindow(flow)).statusCode).toBe(400);
      expect(await issuedCodes(flow.email)).toHaveLength(1);
    });

    it('hears a completion over the socket before it closes', async () => {
      const flow = await h.start();
      const events: string[] = [];
      let resolveClosed!: () => void;
      const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
      await h.app.injectWS(`/auth/registration/events?${queryA}&id=${flow.id}`, { headers: { cookie: flow.cookie, origin }, socket: peer }, {
        onInit: client => {
          client.on('message', value => events.push(String(value)));
          client.on('close', () => { events.push('closed'); resolveClosed(); });
        },
      });
      expect((await h.finish(await h.open(flow))).statusCode).toBe(200);
      await closed;
      expect(events).toEqual([JSON.stringify({ type: 'registration.changed' }), 'closed']);
    });
  });

  describe('2FA and workspace, the same as ordinary verification', () => {
    const twoFa = (challenge: string) => flowQuery(challenge, twoFaConfigUrl);
    const chooser = (challenge: string) => flowQuery(challenge, chooserConfigUrl);

    it('asks the original window for its second factor instead of issuing a code', async () => {
      await h.db.prisma.clientDomain.upsert({ where: { domain: 'client.example.com' },
        create: { domain: 'client.example.com', label: 'Client', twoFaPolicy: 'OPTIONAL' }, update: { twoFaPolicy: 'OPTIONAL' } });
      const flow = await h.start(undefined, twoFa(challengeA));
      expect((await h.finish(await h.open(flow), twoFa(challengeB))).statusCode).toBe(200);
      await h.db.prisma.user.updateMany({ where: { email: flow.email }, data: { twoFaEnabled: true } });
      const done = await h.continueWindow(flow, flow.cookie, twoFa(challengeA));
      expect(done.statusCode, done.body).toBe(200);
      expect(done.json()).toMatchObject({ ok: true, twofa_required: true });
      expect(done.json().redirect_to).toBeUndefined();
      expect(await issuedCodes(flow.email)).toHaveLength(1);
    });

    it('sends both browsers to required 2FA enrolment', async () => {
      await h.db.prisma.clientDomain.update({ where: { domain: 'client.example.com' }, data: { twoFaPolicy: 'REQUIRED' } });
      try {
        const flow = await h.start(undefined, twoFa(challengeA));
        const clicked = await h.finish(await h.open(flow), twoFa(challengeB));
        const original = await h.continueWindow(flow, flow.cookie, twoFa(challengeA));
        for (const response of [clicked, original]) {
          expect(response.statusCode, response.body).toBe(200);
          expect(response.json()).toMatchObject({ ok: true, twofa_enroll_required: true });
        }
        expect(await issuedCodes(flow.email)).toHaveLength(0);
      } finally {
        await h.db.prisma.clientDomain.update({ where: { domain: 'client.example.com' }, data: { twoFaPolicy: 'OPTIONAL' } });
      }
    });

    it('sends both browsers to the workspace chooser, each with its own PKCE in the bridge', async () => {
      const flow = await h.start(undefined, chooser(challengeA));
      const clicked = await h.finish(await h.open(flow), chooser(challengeB));
      expect(clicked.statusCode, clicked.body).toBe(200);
      expect(clicked.json().login_token).toEqual(expect.any(String));
      const original = await h.continueWindow(flow, flow.cookie, chooser(challengeA));
      expect(original.statusCode, original.body).toBe(200);
      expect(original.json().login_token).toEqual(expect.any(String));
      expect(original.json().login_token).not.toBe(clicked.json().login_token);
      expect(Object.keys(original.json()).sort()).toEqual(Object.keys(clicked.json()).sort());
    });

    it('answers the registration restart URL the signed config has', async () => {
      const flow = await h.start();
      expect((await h.link(flow)).json().next).toBe(registrationRestartUrl);
    });
  });
});
