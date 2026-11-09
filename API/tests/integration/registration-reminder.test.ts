import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mailbox = vi.hoisted(() => ({ messages: [] as Array<{ to: string; link: string; code: string }> }));
vi.mock('../../src/services/email.service.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/services/email.service.js')>(),
  sendRegistrationVerificationEmail: async (message: { to: string; link: string; code: string }) => { mailbox.messages.push(message); },
}));
const banned = vi.hoisted(() => ({ value: false }));
vi.mock('../../src/services/ban-policy.service.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/services/ban-policy.service.js')>(),
  isPrincipalBannedForRegistration: async () => banned.value,
}));

import { sweepRegistrationReminders } from '../../src/services/registration-reminder.service.js';
import { buildUserIdentity } from '../../src/services/user-scope.service.js';
import {
  createRegistrationHarness, origin, queryA, type Flow, type RegistrationHarness,
} from '../helpers/pending-registration-harness.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
// 11:00 in Prague (CET): inside the send hours.
const NOW = new Date('2026-11-10T10:00:00Z');

type Sent = { to: string; link: string; locale?: string; theme?: unknown };

// HUGO-2424: the one reminder to a registration nobody confirmed.
describe.skipIf(!process.env.DATABASE_URL)('registration reminder', () => {
  let h: RegistrationHarness;
  const sent: Sent[] = [];
  const log = { warn: vi.fn() };
  const send = async (message: Sent) => { sent.push(message); return true; };

  beforeAll(async () => { h = await createRegistrationHarness(mailbox); });
  beforeEach(async () => {
    mailbox.messages.length = 0;
    sent.length = 0;
    log.warn.mockClear();
    banned.value = false;
    await h.db.prisma.pendingRegistration.deleteMany();
  });
  afterAll(async () => { await h?.close(); });

  const row = (flow: Flow) => h.db.prisma.pendingRegistration.findUniqueOrThrow({ where: { id: flow.id } });
  /** Both the row and its token end `remainingMs` after `now`: they are one expiry. */
  async function pin(flow: Flow, remainingMs: number, now = NOW): Promise<void> {
    const stored = await row(flow);
    const expiresAt = new Date(now.getTime() + remainingMs);
    await h.db.prisma.pendingRegistration.update({ where: { id: flow.id }, data: { expiresAt } });
    await h.db.prisma.verificationToken.update({ where: { tokenHash: stored.completionHash }, data: { expiresAt } });
  }
  const sweep = (now = NOW, extra: Parameters<typeof sweepRegistrationReminders>[0] = {}) =>
    sweepRegistrationReminders({ prisma: h.db.prisma, now: () => now, send, log, ...extra });
  /** A flow whose "email" is the reminder's: the same helpers then open and finish it. */
  const reminderFlow = (flow: Flow): Flow => ({ ...flow, message: { ...flow.message, link: sent.at(-1)!.link } });

  it('sends one reminder, to the address, with a new link and the same expiry', async () => {
    const flow = await h.start();
    await pin(flow, 10 * HOUR);
    const before = await row(flow);
    expect(await sweep()).toEqual({ claimed: 1, sent: 1, failed: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(flow.email);
    const link = new URL(sent[0]!.link);
    expect(link.origin + link.pathname).toBe(`${origin}/auth/registration/link`);
    expect(link.hash.slice(1)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sent[0]!.link).not.toBe(flow.message.link);
    const after = await row(flow);
    expect(after.expiresAt).toEqual(before.expiresAt);
    expect(after.reminderSentAt).toEqual(NOW);
    expect(after.reminderLinkHash).not.toBeNull();
    expect(after.linkHash).toBe(before.linkHash);
    expect(await h.db.prisma.verificationToken.count({ where: { email: flow.email } })).toBe(1);
    // And never a second one
    expect(await sweep(new Date(NOW.getTime() + 5 * MIN))).toEqual({ claimed: 0, sent: 0, failed: 0 });
    expect(sent).toHaveLength(1);
  });

  it('keeps the language and the look of the registration e-mail', async () => {
    const start = await h.app.inject({ method: 'POST', url: `/auth/registration/start?${queryA}`, payload: { email: 'cs-reminder@example.com' },
      headers: { origin, 'x-forwarded-for': '192.0.2.77', 'accept-language': 'cs-CZ,cs;q=0.9' } });
    expect(start.statusCode, start.body).toBe(200);
    const flow = { id: start.json().registration_id as string } as Flow;
    const stored = await row(flow);
    expect(stored.locale).toBe('cs');
    expect(stored.emailTheme).toMatchObject({ primary: expect.any(String), bg: expect.any(String) });
    await pin(flow, 10 * HOUR);
    await sweep();
    expect(sent[0]!.locale).toBe('cs');
    expect(sent[0]!.theme).toEqual(stored.emailTheme);
  });

  it('sends English when the language is unknown', async () => {
    const flow = await h.start();
    await h.db.prisma.pendingRegistration.update({ where: { id: flow.id }, data: { locale: null, emailTheme: Prisma.DbNull } });
    await pin(flow, 10 * HOUR);
    await sweep();
    expect(sent[0]!.locale).toBe('en');
    expect(sent[0]!.theme).toBeUndefined();
  });

  it.each([
    ['1:29', 0, 89 * MIN], ['1:30', 1, 90 * MIN], ['16:00', 1, 16 * HOUR], ['16:01', 0, 16 * HOUR + MIN],
  ])('with %s left on the link, reminders sent: %s', async (_name, expected, remaining) => {
    const flow = await h.start();
    await pin(flow, remaining);
    await sweep();
    expect(sent).toHaveLength(expected);
  });

  it.each([
    ['08:59', 0, '2026-11-10T07:59:00Z'], ['09:00', 1, '2026-11-10T08:00:00Z'],
    ['18:59', 1, '2026-11-10T17:59:00Z'], ['19:00', 0, '2026-11-10T18:00:00Z'],
    ['summer 08:59', 0, '2026-07-10T06:59:00Z'], ['summer 09:00', 1, '2026-07-10T07:00:00Z'],
  ])('at %s Prague time, reminders sent: %s', async (_name, expected, iso) => {
    const flow = await h.start();
    await pin(flow, 8 * HOUR, new Date(iso));
    await sweep(new Date(iso));
    expect(sent).toHaveLength(expected);
  });

  it('on the day clocks go back, 09:00 is 08:00Z and 08:59 is not yet', async () => {
    const flow = await h.start();
    await pin(flow, 8 * HOUR, new Date('2026-10-25T07:59:00Z'));
    await sweep(new Date('2026-10-25T07:59:00Z'));
    expect(sent).toHaveLength(0);
    await pin(flow, 8 * HOUR, new Date('2026-10-25T08:00:00Z'));
    await sweep(new Date('2026-10-25T08:00:00Z'));
    expect(sent).toHaveLength(1);
  });

  it('two concurrent sweeps send exactly one reminder', async () => {
    const flow = await h.start();
    await pin(flow, 10 * HOUR);
    const results = await Promise.all([sweep(), sweep(), sweep()]);
    expect(sent).toHaveLength(1);
    expect(results.reduce((total, result) => total + result.sent, 0)).toBe(1);
    expect(results.reduce((total, result) => total + result.claimed, 0)).toBe(1);
    expect(await row(flow)).toMatchObject({ reminderSentAt: NOW });
  });

  it('every tick of the day sends exactly one reminder to a registration at 11:00', async () => {
    const flow = await h.start();
    const registeredAt = new Date('2026-11-10T10:00:00Z'); // 11:00 Prague
    await pin(flow, 24 * HOUR, registeredAt);
    for (let tick = registeredAt.getTime(); tick < registeredAt.getTime() + 24 * HOUR; tick += 5 * MIN) await sweep(new Date(tick));
    expect(sent).toHaveLength(1);
    expect((await row(flow)).reminderSentAt).toEqual(new Date('2026-11-11T08:00:00Z')); // 09:00 Prague, the next day
  });

  describe('the reminder link and the first link are one registration', () => {
    const finishFrom = async (flow: Flow) => {
      const cookie = await h.open(flow);
      await h.auth(cookie);
      return h.finish(cookie);
    };

    it('finishing from the reminder completes it; the original link and window then report used', async () => {
      const flow = await h.start();
      await pin(flow, 10 * HOUR);
      await sweep();
      const reminder = reminderFlow(flow);
      expect((await h.link(reminder)).json().status).toBe('continue');
      expect((await finishFrom(reminder)).statusCode).toBe(200);
      expect((await h.link(flow)).json()).toMatchObject({ status: 'complete' });
      expect((await h.link(reminder)).json()).toMatchObject({ status: 'complete' });
      expect((await h.status(flow)).json()).toEqual({ status: 'complete' });
      expect(await h.db.prisma.user.count({ where: { email: flow.email } })).toBe(1);
    });

    it('finishing from the original completes it; the reminder link then reports used', async () => {
      const flow = await h.start();
      await pin(flow, 10 * HOUR);
      await sweep();
      const reminder = reminderFlow(flow);
      expect((await finishFrom(flow)).statusCode).toBe(200);
      expect((await h.link(reminder)).json()).toMatchObject({ status: 'complete' });
      expect((await h.link(flow)).json()).toMatchObject({ status: 'complete' });
      expect(await h.db.prisma.user.count({ where: { email: flow.email } })).toBe(1);
    });

    it('expires with the first link: the same instant, never later', async () => {
      const flow = await h.start();
      await pin(flow, 10 * HOUR);
      await sweep();
      await h.db.prisma.pendingRegistration.update({ where: { id: flow.id }, data: { expiresAt: new Date(Date.now() - MIN) } });
      expect((await h.link(reminderFlow(flow))).json().status).toBe('expired');
      expect((await h.link(flow)).json().status).toBe('expired');
    });
  });

  describe('never reminds', () => {
    it('an address that has an account now', async () => {
      const flow = await h.start();
      await pin(flow, 10 * HOUR);
      const identity = buildUserIdentity({ userScope: 'global', email: flow.email, domain: 'client.example.com' });
      await h.db.prisma.user.create({ data: { userKey: identity.userKey, email: identity.email, domain: identity.domain } });
      await sweep();
      expect(sent).toHaveLength(0);
      expect((await row(flow)).reminderSentAt).toBeNull();
    });

    it('a banned address', async () => {
      const flow = await h.start();
      await pin(flow, 10 * HOUR);
      banned.value = true;
      await sweep();
      expect(sent).toHaveLength(0);
    });

    it.each([
      ['a verified code', { emailVerifiedAt: NOW, browserAuthorizedAt: NOW }],
      ['a completed registration', { completedAt: NOW, completedUserId: 'user', completedEpoch: 0 }],
      ['an expired registration', { expiresAt: new Date(NOW.getTime() - HOUR) }],
      ['a registration out of attempts', { attempts: 5 }],
    ])('%s', async (_name, data) => {
      const flow = await h.start();
      await pin(flow, 10 * HOUR);
      await h.db.prisma.pendingRegistration.update({ where: { id: flow.id }, data });
      await sweep();
      expect(sent).toHaveLength(0);
    });

    it('a used verification token', async () => {
      const flow = await h.start();
      await pin(flow, 10 * HOUR);
      await h.db.prisma.verificationToken.updateMany({ where: { email: flow.email }, data: { usedAt: NOW } });
      await sweep();
      expect(sent).toHaveLength(0);
    });

    it('a registration made the old way (a legacy token with no pending row)', async () => {
      await h.db.prisma.verificationToken.create({ data: {
        type: 'VERIFY_EMAIL_SET_PASSWORD', email: 'legacy@example.com', userKey: 'legacy-key', domain: 'client.example.com',
        configUrl: 'https://client.example.com/auth-config', tokenHash: 'legacy-hash', expiresAt: new Date(NOW.getTime() + 10 * HOUR),
      } });
      expect(await sweep()).toEqual({ claimed: 0, sent: 0, failed: 0 });
    });
  });

  it('still reminds a registration whose link was opened (a mail scanner opens links too)', async () => {
    const flow = await h.start();
    await pin(flow, 10 * HOUR);
    await h.link(flow);
    expect((await row(flow)).linkUsedAt).not.toBeNull();
    await sweep();
    expect(sent).toHaveLength(1);
  });

  it('reminds an address once, for its newest registration, after a resend', async () => {
    const first = await h.start();
    const second = await h.resend(first);
    await pin(first, 10 * HOUR);
    await pin(second, 12 * HOUR);
    await sweep();
    await sweep(new Date(NOW.getTime() + 5 * MIN));
    expect(sent).toHaveLength(1);
    expect((await row(second)).reminderSentAt).not.toBeNull();
    expect((await row(first)).reminderSentAt).toBeNull();
    // The reminder still finishes the whole family, the first window included.
    const cookie = await h.open(reminderFlow(second));
    await h.auth(cookie);
    expect((await h.finish(cookie)).statusCode).toBe(200);
    expect((await h.status(first)).json()).toEqual({ status: 'complete' });
  });

  it('does not retry a reminder that was not sent, and logs the row, never the address', async () => {
    const flow = await h.start();
    await pin(flow, 10 * HOUR);
    expect(await sweep(NOW, { send: async () => false })).toEqual({ claimed: 1, sent: 0, failed: 1 });
    expect(log.warn).toHaveBeenCalledTimes(1);
    const [details, message] = log.warn.mock.calls[0]!;
    expect(details).toEqual({ registrationId: flow.id });
    expect(JSON.stringify([details, message])).not.toContain(flow.email);
    expect(await sweep(new Date(NOW.getTime() + 5 * MIN))).toEqual({ claimed: 0, sent: 0, failed: 0 });
    expect(sent).toHaveLength(0);
    expect((await row(flow)).reminderSentAt).not.toBeNull();
  });

  it('counts a thrown send as failed and goes on to the next registration', async () => {
    const one = await h.start();
    const two = await h.start();
    await pin(one, 10 * HOUR);
    await pin(two, 11 * HOUR);
    let calls = 0;
    const flaky = async (message: Sent) => { calls += 1; if (calls === 1) throw new Error('provider down'); sent.push(message); return true; };
    expect(await sweep(NOW, { send: flaky })).toEqual({ claimed: 2, sent: 1, failed: 1 });
  });
});
