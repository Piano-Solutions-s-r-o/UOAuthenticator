import { createHash } from 'node:crypto';

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
import { cleanClientDomains, seedDomainSecret } from '../helpers/domain-secret.js';
import {
  challengeA, challengeB, codeOf, configUrl, createRegistrationHarness, flowQuery, origin, peer, queryA, queryB,
  registrationRestartUrl, type RegistrationHarness,
} from '../helpers/pending-registration-harness.js';

// HUGO-2261: after the password is set where the link was clicked, the original window goes in by itself.
describe.skipIf(!process.env.DATABASE_URL)('the original window after a registration finished elsewhere', () => {
  let h: RegistrationHarness;
  const twoFaConfigUrl = 'https://client.example.com/auth-config-2fa';
  const chooserConfigUrl = 'https://client.example.com/auth-config-chooser';

  beforeAll(async () => {
    h = await createRegistrationHarness(mailbox, {
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
      expect(await h.db.prisma.authFunnelDailyCount.findFirst({ where: { step: 'original_device_returned', outcome: 'continued' } })).not.toBeNull();
    });

    it('stays out when the link opened in another tab of the same browser', async () => {
      const flow = await h.start();
      const done = await h.finish(`${await h.open(flow)}; ${flow.cookie}`);
      expect(done.statusCode, done.body).toBe(200);
      expect((await h.status(flow)).json()).toEqual({ status: 'complete' });
      expect((await h.continueWindow(flow)).statusCode).toBe(400);
      expect(await issuedCodes(flow.email)).toHaveLength(1);
    });

    it('stays out too when an older link opened beside a window on the newest resend', async () => {
      const first = await h.start();
      const second = await h.resend(first);
      expect((await h.finish(`${await h.open(first)}; ${first.cookie}; ${second.cookie}`)).statusCode).toBe(200);
      expect((await h.continueWindow(second)).statusCode).toBe(400);
      expect(await issuedCodes(first.email)).toHaveLength(1);
    });

    it('still goes in when the browser that opened the link only guesses the cookie', async () => {
      const flow = await h.start();
      const guessed = `${flow.cookie.split('=')[0]}=guessed`;
      expect((await h.finish(`${await h.open(flow)}; ${guessed}`)).statusCode).toBe(200);
      expect((await h.continueWindow(flow)).statusCode).toBe(200);
    });

    it('answers complete to a code typed after the password was set elsewhere', async () => {
      const flow = await h.start();
      expect((await h.finish(await h.open(flow))).statusCode).toBe(200);
      const late = await h.code(flow);
      expect(late.statusCode).toBe(200);
      expect(late.json()).toEqual({ status: 'complete' });
      expect((await row(flow.id)).browserAuthorizedAt).toBeNull();
    });

    it('redeems each code only with the verifier of the browser it was issued to', async () => {
      const pkce = (name: string) => {
        const verifier = `${name}-verifier-`.padEnd(64, '0');
        return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
      };
      await cleanClientDomains(h.db.prisma);
      const clientHash = await seedDomainSecret(h.db.prisma, 'client.example.com');
      const exchange = (response: Parameters<typeof codeOf>[0], verifier: string) => h.app.inject({
        method: 'POST', url: `/auth/token?config_url=${encodeURIComponent(configUrl)}`,
        headers: { authorization: `Bearer ${clientHash}`, 'x-forwarded-for': '198.51.100.42' },
        payload: { code: codeOf(response), redirect_url: 'https://client.example.com/oauth/callback', code_verifier: verifier },
      });
      const windowKey = pkce('window');
      const clickedKey = pkce('clicked');
      const run = async () => {
        const flow = await h.start(undefined, flowQuery(windowKey.challenge));
        const clicked = await h.finish(await h.open(flow), flowQuery(clickedKey.challenge));
        const original = await h.continueWindow(flow, flow.cookie, flowQuery(windowKey.challenge));
        expect([clicked.statusCode, original.statusCode]).toEqual([200, 200]);
        return { clicked, original };
      };
      const first = await run();
      expect((await exchange(first.clicked, windowKey.verifier)).statusCode).toBe(401);
      expect((await exchange(first.original, clickedKey.verifier)).statusCode).toBe(401);
      const second = await run();
      const clickedTokens = await exchange(second.clicked, clickedKey.verifier);
      expect(clickedTokens.statusCode, clickedTokens.body).toBe(200);
      const windowTokens = await exchange(second.original, windowKey.verifier);
      expect(windowTokens.statusCode, windowTokens.body).toBe(200);
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

    it('gives no second continuation after a resend added a row to the family', async () => {
      const flow = await h.start();
      expect((await h.finish(await h.open(flow))).statusCode).toBe(200);
      expect((await h.continueWindow(flow)).statusCode).toBe(200);
      const resent = await h.resend(flow);
      expect((await row(resent.id)).completedAt).toBeNull();
      expect((await h.continueWindow(flow)).statusCode).toBe(400);
      expect((await h.continueWindow(resent)).statusCode).toBe(400);
      expect(await issuedCodes(flow.email)).toHaveLength(2);
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
