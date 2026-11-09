import { describe, expect, it, vi } from 'vitest';

import { parseEnv } from '../../src/config/env.js';
import {
  REGISTRATION_REMINDER_MAX_REMAINING_MS, REGISTRATION_REMINDER_MIN_REMAINING_MS, REGISTRATION_REMINDER_TICK_MS,
} from '../../src/config/constants.js';
import { buildRegistrationReminderTemplate } from '../../src/services/email.templates.registration-reminder.js';
import { escapeHtml } from '../../src/services/email.templates.js';
import { startRegistrationReminderScheduler } from '../../src/services/registration-reminder-scheduler.service.js';
import { isReminderDue, isReminderSendTime } from '../../src/services/registration-reminder.service.js';
import { isPragueHourWindow, pragueMinuteOfDay } from '../../src/utils/prague-time.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const at = (iso: string) => new Date(iso);

describe('Prague send hours (HUGO-2424)', () => {
  // November is CET (UTC+1), July is CEST (UTC+2): the same wall clock is a different UTC instant.
  it.each([
    ['winter 08:59', '2026-11-10T07:59:00Z', false],
    ['winter 09:00', '2026-11-10T08:00:00Z', true],
    ['winter 18:59', '2026-11-10T17:59:00Z', true],
    ['winter 19:00', '2026-11-10T18:00:00Z', false],
    ['summer 08:59', '2026-07-10T06:59:00Z', false],
    ['summer 09:00', '2026-07-10T07:00:00Z', true],
    ['summer 18:59', '2026-07-10T16:59:00Z', true],
    ['summer 19:00', '2026-07-10T17:00:00Z', false],
  ])('%s', (_name, iso, expected) => {
    expect(isReminderSendTime(at(iso))).toBe(expected);
  });

  it('follows the clock change on the day clocks go back (2026-10-25, 03:00 CEST becomes 02:00 CET)', () => {
    expect(isReminderSendTime(at('2026-10-24T06:59:00Z'))).toBe(false); // 08:59 CEST
    expect(isReminderSendTime(at('2026-10-24T07:00:00Z'))).toBe(true); // 09:00 CEST
    expect(pragueMinuteOfDay(at('2026-10-25T00:59:00Z'))).toBe(2 * 60 + 59); // Still CEST
    expect(pragueMinuteOfDay(at('2026-10-25T01:00:00Z'))).toBe(2 * 60); // The repeated hour: now CET
    expect(isReminderSendTime(at('2026-10-25T07:59:00Z'))).toBe(false); // 08:59 CET
    expect(isReminderSendTime(at('2026-10-25T08:00:00Z'))).toBe(true); // 09:00 CET
    expect(isReminderSendTime(at('2026-10-25T17:59:00Z'))).toBe(true); // 18:59 CET
    expect(isReminderSendTime(at('2026-10-25T18:00:00Z'))).toBe(false); // 19:00 CET
  });

  it('follows the clock change on the day clocks go forward (2027-03-28, 02:00 CET becomes 03:00 CEST)', () => {
    expect(pragueMinuteOfDay(at('2027-03-28T00:59:00Z'))).toBe(1 * 60 + 59); // Still CET
    expect(pragueMinuteOfDay(at('2027-03-28T01:00:00Z'))).toBe(3 * 60); // 02:00 never happens
    expect(isReminderSendTime(at('2027-03-28T06:59:00Z'))).toBe(false); // 08:59 CEST
    expect(isReminderSendTime(at('2027-03-28T07:00:00Z'))).toBe(true); // 09:00 CEST
    expect(isReminderSendTime(at('2027-03-28T16:59:00Z'))).toBe(true); // 18:59 CEST
    expect(isReminderSendTime(at('2027-03-28T17:00:00Z'))).toBe(false); // 19:00 CEST
  });

  it('reads the hour window it is given', () => {
    expect(isPragueHourWindow(at('2026-11-10T10:00:00Z'), 11, 12)).toBe(true); // 11:00 CET
    expect(isPragueHourWindow(at('2026-11-10T11:00:00Z'), 11, 12)).toBe(false);
  });
});

describe('time left on the link (HUGO-2424)', () => {
  const now = at('2026-11-10T10:00:00Z');
  const pending = (remainingMs: number, overrides: Record<string, unknown> = {}) => ({
    expiresAt: new Date(now.getTime() + remainingMs), completedAt: null, emailVerifiedAt: null,
    browserAuthorizedAt: null, reminderSentAt: null, attempts: 0, ...overrides,
  });

  it('names its bounds: 1 h 30 min to 16 h', () => {
    expect(REGISTRATION_REMINDER_MIN_REMAINING_MS).toBe(90 * MIN);
    expect(REGISTRATION_REMINDER_MAX_REMAINING_MS).toBe(16 * HOUR);
  });

  it.each([
    ['1:29 left', 89 * MIN, false],
    ['1:30 left', 90 * MIN, true],
    ['16:00 left', 16 * HOUR, true],
    ['16:01 left', 16 * HOUR + MIN, false],
    ['expired', -MIN, false],
  ])('%s', (_name, remaining, expected) => {
    expect(isReminderDue(pending(remaining), now)).toBe(expected);
  });

  it.each([
    ['completed', { completedAt: now }],
    ['the code was verified', { emailVerifiedAt: now }],
    ['the browser was authorized', { browserAuthorizedAt: now }],
    ['already reminded', { reminderSentAt: now }],
    ['out of attempts', { attempts: 5 }],
  ])('never when %s', (_name, overrides) => {
    expect(isReminderDue(pending(8 * HOUR, overrides), now)).toBe(false);
  });

  // The link lives 24 h. Whatever time of day a registration is made, the reminder window and the
  // Prague send hours overlap, and the owner's 1 h 30 min lower bound keeps that overlap long
  // enough for a 5-minute tick: the registration at 11:00 is the worst case.
  describe.each([['summer', '2026-07-14'], ['winter', '2026-12-09']])('every 15 minutes of a %s day', (_season, day) => {
    it('has an eligible tick, and the 11:00 registration is reminded from 09:00 to 09:30 the next day', () => {
      // Local midnight of that day as a UTC instant, found without a fixed offset.
      const start = Date.parse(`${day}T00:00:00Z`) - 2 * HOUR;
      const midnight = start + (24 * 60 - pragueMinuteOfDay(new Date(start))) % (24 * 60) * MIN;
      expect(pragueMinuteOfDay(new Date(midnight))).toBe(0);
      let worst = Infinity;
      for (let minute = 0; minute < 24 * 60; minute += 15) {
        const registeredAt = midnight + minute * MIN;
        const expiresAt = new Date(registeredAt + 24 * HOUR);
        const eligible: number[] = [];
        let sent = 0;
        let reminderSentAt: Date | null = null;
        for (let tick = registeredAt; tick < expiresAt.getTime(); tick += REGISTRATION_REMINDER_TICK_MS) {
          const when = new Date(tick);
          if (isReminderSendTime(when) && isReminderDue({ ...pending(0), expiresAt }, when)) eligible.push(tick);
          // The sweep itself: the first eligible tick claims the row, and a claimed row is never due again.
          if (isReminderSendTime(when) && isReminderDue({ ...pending(0), expiresAt, reminderSentAt }, when)) {
            reminderSentAt = when;
            sent += 1;
          }
        }
        expect(sent, `registered at ${minute / 60}h`).toBe(1);
        expect(eligible.length, `registered at ${minute / 60}h`).toBeGreaterThanOrEqual(6);
        worst = Math.min(worst, eligible.length);
        if (minute === 11 * 60) {
          const first = pragueMinuteOfDay(new Date(eligible[0]!));
          const last = pragueMinuteOfDay(new Date(eligible.at(-1)!));
          expect(first).toBe(9 * 60);
          expect(last).toBeLessThanOrEqual(9 * 60 + 30);
          expect(new Date(eligible[0]!).getTime()).toBeGreaterThan(registeredAt + 21 * HOUR);
        }
      }
      expect(worst).toBeGreaterThanOrEqual(6); // 30 minutes of 5-minute ticks
    });
  });
});

describe('the reminder e-mail (HUGO-2424)', () => {
  const link = 'https://sso.example.com/auth/registration/link#abc_DEF-123';

  it('reads exactly as the owner wrote it in Czech', () => {
    const mail = buildRegistrationReminderTemplate({ link, locale: 'cs' });
    expect(mail.subject).toBe('Tik ťak, tvůj přihlašovací odkaz do Huga čeká');
    expect(mail.text).toBe([
      'Pojďme tě opravdu přihlásit! 💛',
      '',
      'Odkaz platí už jen pár hodin, tak to neprošvihni! Jsi totiž jen jedno kliknutí od cíle. Nestyď se, klikni na tlačítko níže, dokonči registraci a rozjeď to se mnou ve velkém',
      link,
      '',
      'Pak to spolu konečně rozjedem!',
      '',
      'Tohle jsi nebyl/a ty? Tak na to rychle zapomeň!',
    ].join('\n'));
    for (const line of [
      'Pojďme tě opravdu přihlásit! 💛',
      'Odkaz platí už jen pár hodin, tak to neprošvihni! Jsi totiž jen jedno kliknutí od cíle. Nestyď se, klikni na tlačítko níže, dokonči registraci a rozjeď to se mnou ve velkém',
      'Pak to spolu konečně rozjedem!',
      'Tohle jsi nebyl/a ty? Tak na to rychle zapomeň!',
    ]) expect(mail.html).toContain(escapeHtml(line));
    expect(mail.html).toContain('<html lang="cs">');
    expect(mail.html).toContain(`href="${link}"`);
    expect(mail.html).toContain('>Pokračovat</a>'); // The registration e-mail's own button label
  });

  it('reads as the draft English, and English is the fallback', () => {
    const mail = buildRegistrationReminderTemplate({ link, locale: 'en' });
    expect(mail.subject).toBe('Tick tock, your Hugo sign-in link is waiting');
    expect(mail.text).toBe([
      "Let's get you signed in for real! 💛",
      '',
      "Your link is only valid for a few more hours, so don't miss it! You're just one click away. Don't be shy — click the button below, finish signing up and let's get going big time",
      link,
      '',
      "Then we'll finally get rolling together!",
      '',
      "Wasn't this you? Just forget about it!",
    ].join('\n'));
    expect(mail.html).toContain(escapeHtml("Let's get you signed in for real! 💛"));
    expect(mail.html).toContain('>Continue</a>');
    expect(buildRegistrationReminderTemplate({ link }).subject).toBe(mail.subject);
  });

  it('carries no code and uses the product theme', () => {
    const mail = buildRegistrationReminderTemplate({ link, locale: 'en', theme: { primary: '#123456', logoText: 'Hugo' } });
    expect(mail.html).toContain('#123456');
    expect(mail.html).toContain('Hugo');
    expect(mail.html).not.toContain('letter-spacing:8px');
  });
});

describe('the reminder scheduler and its kill switch (HUGO-2424)', () => {
  it('is off unless UOA_REGISTRATION_REMINDER_ENABLED is set', () => {
    const base = { NODE_ENV: 'test', HOST: '127.0.0.1', PORT: '3000', PUBLIC_BASE_URL: 'https://auth.example.com',
      LOG_LEVEL: 'info', SHARED_SECRET: 'test-shared-secret-with-enough-length', AUTH_SERVICE_IDENTIFIER: 'uoa-auth-service',
      ADMIN_ACCESS_TOKEN_SECRET: 'admin-token-secret-with-enough-length',
      CONFIG_JWKS_URL: 'https://auth.example.com/.well-known/jwks.json',
      CONFIG_JWKS_JSON: '{"keys":[{"kty":"RSA","kid":"test","n":"abc","e":"AQAB"}]}',
      ACCESS_TOKEN_TTL: '30m', REFRESH_TOKEN_TTL_DAYS: '30', LOG_RETENTION_DAYS: '90' } as NodeJS.ProcessEnv;
    expect(parseEnv(base).UOA_REGISTRATION_REMINDER_ENABLED).toBe(false);
    expect(parseEnv({ ...base, UOA_REGISTRATION_REMINDER_ENABLED: 'true' }).UOA_REGISTRATION_REMINDER_ENABLED).toBe(true);
  });

  it('sweeps at once and on every tick, never two at a time, and stops', async () => {
    vi.useFakeTimers();
    try {
      let release: () => void = () => undefined;
      let calls = 0;
      const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const scheduler = startRegistrationReminderScheduler({
        log, intervalMs: 1000,
        runSweep: async () => { calls += 1; await new Promise<void>((resolve) => { release = resolve; }); return { claimed: 1, sent: 1, failed: 0 }; },
      });
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(3000); // Ticks while the first sweep still runs
      expect(calls).toBe(1);
      release();
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls).toBe(2);
      expect(log.info).toHaveBeenCalledWith({ claimed: 1, sent: 1, failed: 0 }, 'registration reminder sweep completed');
      scheduler.stop();
      release();
      await vi.advanceTimersByTimeAsync(5000);
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps going after a failed sweep', async () => {
    vi.useFakeTimers();
    try {
      const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const runSweep = vi.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValue({ claimed: 0, sent: 0, failed: 0 });
      const scheduler = startRegistrationReminderScheduler({ log, intervalMs: 1000, runSweep });
      await vi.advanceTimersByTimeAsync(1000);
      expect(runSweep).toHaveBeenCalledTimes(2);
      expect(log.error).toHaveBeenCalledTimes(1);
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
