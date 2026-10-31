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

import { subscribeRegistrationChanges } from '../../src/services/registration-events.service.js';
import {
  challengeA, challengeB, codeOf, configUrl, createRegistrationHarness, flowQuery, loginRestartUrl, offersPassword,
  origin, otherDomainConfigUrl, password, queryA, queryB, registerQueryB, siblingConfigUrl, type RegistrationHarness,
} from '../helpers/pending-registration-harness.js';

// HUGO-2261: the person finishes where they clicked, and the original window follows by itself.
describe.skipIf(!process.env.DATABASE_URL)('finishing a registration where the link was opened', () => {
  let h: RegistrationHarness;
  const changingConfigUrl = 'https://client.example.com/auth-config-changing';

  beforeAll(async () => {
    h = await createRegistrationHarness(mailbox, {
      [changingConfigUrl]: { language_config: 'en' },
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

    it('leaves a plain sign-in in that browser alone', async () => {
      const flow = await h.start();
      const page = await h.auth(await h.open(flow), queryB);
      expect(page.statusCode).toBe(200);
      expect(page.body).not.toContain('__UOA_REGISTRATION_HANDOFF__');
    });

    it('does not count a flow start for the product coming back', async () => {
      const flow = await h.start();
      const cookie = await h.open(flow);
      const counted = () => h.db.prisma.authFunnelDailyCount.aggregate({ _sum: { count: true }, where: { step: 'flow_started', domain: 'client.example.com' } });
      const before = (await counted())._sum.count ?? 0;
      await h.auth(cookie);
      expect((await counted())._sum.count ?? 0).toBe(before);
    });

    it.each([
      ['another product domain', () => `${flowQuery(challengeB, otherDomainConfigUrl)}&prompt=create`],
      ['another config of the same domain', () => `${flowQuery(challengeB, siblingConfigUrl)}&prompt=create`],
      ['no PKCE', () => `${new URLSearchParams({ config_url: configUrl })}&prompt=create`],
      ['a plain PKCE method', () => `${new URLSearchParams({ config_url: configUrl, code_challenge: challengeB, code_challenge_method: 'plain' })}&prompt=create`],
      ['a mid-flow render', () => `${registerQueryB}&twofa_token=abc`],
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
      const page = await h.auth(cookie, `${flowQuery(challengeB, changingConfigUrl)}&prompt=create`);
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
      vi.useFakeTimers({ now: Date.now() + 61 * 60 * 1000, toFake: ['Date'] });
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

    it('tells a second tab of that browser that the registration is finished', async () => {
      const flow = await h.start();
      const cookie = await h.open(flow);
      expect((await h.finish(cookie)).statusCode).toBe(200);
      const second = await h.finish(cookie);
      expect(second.statusCode).toBe(400);
      expect(second.json().code).toBe('REGISTRATION_COMPLETE');
      expect(await issuedCodes(flow.email)).toHaveLength(1);
    });

    it('spends the one verification token', async () => {
      const flow = await h.start();
      expect((await h.finish(await h.open(flow))).statusCode).toBe(200);
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

    it('refuses when a newer link replaced the cookie after the form showed another address', async () => {
      const shown = await h.start();
      const other = await h.start();
      await h.open(shown);
      const replaced = await h.open(other);
      const response = await h.finish(replaced, queryB, { email: shown.email, password });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('REGISTRATION_UNAVAILABLE');
      expect(await h.db.prisma.user.count({ where: { email: { in: [shown.email, other.email] } } })).toBe(0);
      expect((await h.finish(replaced)).statusCode).toBe(200);
    });

    it('refuses a password that names no address', async () => {
      const flow = await h.start();
      const cookie = await h.open(flow);
      const response = await h.finish(cookie, queryB, { password });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('REGISTRATION_UNAVAILABLE');
      expect(await h.db.prisma.user.count({ where: { email: flow.email } })).toBe(0);
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
      const response = await h.finish(cookie, queryB, { email: flow.email });
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

    it('lets the first of two browsers win, and tells the other it is finished', async () => {
      const flow = await h.start();
      const first = await h.open(flow);
      const second = await h.open(flow);
      expect((await h.finish(first)).statusCode).toBe(200);
      const late = await h.finish(second);
      expect(late.statusCode).toBe(400);
      expect(late.json().code).toBe('REGISTRATION_COMPLETE');
      expect(await h.db.prisma.user.count({ where: { email: flow.email } })).toBe(1);
    });

    it('tells the window on its password form that the other browser finished', async () => {
      const flow = await h.start();
      const cookie = await h.open(flow);
      const proof = (await h.code(flow)).json().token as string;
      expect((await h.finish(cookie)).statusCode).toBe(200);
      const late = await h.finishInWindow(flow, proof);
      expect(late.statusCode).toBe(400);
      expect(late.json().code).toBe('REGISTRATION_COMPLETE');
      expect(await issuedCodes(flow.email)).toHaveLength(1);
    });

    it('counts each step of one registration once, by the way it ended', async () => {
      const counted = async (step: string, outcome: string) =>
        (await h.db.prisma.authFunnelDailyCount.aggregate({ _sum: { count: true }, where: { step, outcome, domain: 'client.example.com' } }))._sum.count ?? 0;
      const steps = [
        ['registration_link_handoff', 'opened'], ['registration_password_set', 'link'], ['registration_completed', 'link'],
        ['clicked_device_returned', 'succeeded'],
      ] as const;
      const before = await Promise.all(steps.map(([step, outcome]) => counted(step, outcome)));
      const flow = await h.start();
      const resent = await h.resend(flow);
      await h.open(flow);
      await h.open(resent); // The resent email's link is the same registration.
      const cookie = await h.open(flow); // So is opening one twice.
      expect((await h.finish(cookie)).statusCode).toBe(200);
      const after = await Promise.all(steps.map(([step, outcome]) => counted(step, outcome)));
      expect(after).toEqual(before.map(count => count + 1));
    });

    it('counts the code as the original window finishing', async () => {
      const counted = async (step: string, outcome: string) =>
        (await h.db.prisma.authFunnelDailyCount.aggregate({ _sum: { count: true }, where: { step, outcome, domain: 'client.example.com' } }))._sum.count ?? 0;
      const steps = [['registration_password_set', 'code'], ['registration_completed', 'code'], ['original_device_returned', 'succeeded']] as const;
      const before = await Promise.all(steps.map(([step, outcome]) => counted(step, outcome)));
      const flow = await h.start();
      const proof = (await h.code(flow)).json().token as string;
      expect((await h.finishInWindow(flow, proof)).statusCode).toBe(200);
      const after = await Promise.all(steps.map(([step, outcome]) => counted(step, outcome)));
      expect(after).toEqual(before.map(count => count + 1));
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

    it('wakes every window of the family at once, and only after the commit', async () => {
      const first = await h.start();
      const second = await h.resend(first);
      const read: Array<ReturnType<typeof row>> = [];
      const stop = [first, second].map(flow => subscribeRegistrationChanges(flow.id, () => { read.push(row(flow.id)); }));
      expect((await h.finish(await h.open(first))).statusCode).toBe(200);
      stop.forEach(unsubscribe => unsubscribe());
      expect(read).toHaveLength(2);
      for (const woken of await Promise.all(read)) expect(woken.completedAt).not.toBeNull();
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
});
