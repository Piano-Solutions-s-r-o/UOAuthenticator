import type { Prisma, PrismaClient } from '@prisma/client';

import {
  REGISTRATION_REMINDER_MAX_REMAINING_MS,
  REGISTRATION_REMINDER_MIN_REMAINING_MS,
  REGISTRATION_REMINDER_SEND_END_HOUR,
  REGISTRATION_REMINDER_SEND_START_HOUR,
} from '../config/constants.js';
import { getPublicBaseUrl } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import { runInTransaction } from '../db/tenant-context.js';
import { isPragueHourWindow } from '../utils/prague-time.js';
import { isPrincipalBannedForRegistration } from './ban-policy.service.js';
import type { EmailLocale, EmailTheme } from './email.templates.js';
import { sendRegistrationReminderEmail } from './email.service.js';
import { registrationDigest, registrationSecret, REGISTRATION_MAX_ATTEMPTS } from './registration-credentials.js';
import { readVerificationTokenEpoch } from './verification-token-epoch.service.js';

/**
 * HUGO-2424: one reminder, to a browser-bound registration (HUGO-2261) nobody has confirmed yet.
 * The reminder's link is a second entry into the same row, so it expires with the first and
 * finishing through either one finishes both (`openPendingRegistrationLink`).
 */

type ReminderLog = { warn: (details: object, message: string) => void };
type DueRow = { expiresAt: Date; completedAt: Date | null; emailVerifiedAt: Date | null; browserAuthorizedAt: Date | null; reminderSentAt: Date | null; attempts: number };

export type RegistrationReminderDeps = {
  prisma?: PrismaClient;
  now?: () => Date;
  send?: typeof sendRegistrationReminderEmail;
  isBanned?: typeof isPrincipalBannedForRegistration;
  log?: ReminderLog;
};

export type RegistrationReminderSweep = { claimed: number; sent: number; failed: number };

/** Prague local time, 09:00 up to but not including 19:00. */
export function isReminderSendTime(now: Date): boolean {
  return isPragueHourWindow(now, REGISTRATION_REMINDER_SEND_START_HOUR, REGISTRATION_REMINDER_SEND_END_HOUR);
}

/**
 * Whether this row should be reminded now, for both the candidate query and the recheck under the
 * lock. Opening the link does not count as confirming: a mail scanner opens links too.
 */
export function isReminderDue(row: DueRow, now: Date): boolean {
  if (row.completedAt || row.emailVerifiedAt || row.browserAuthorizedAt || row.reminderSentAt) return false;
  if (row.attempts >= REGISTRATION_MAX_ATTEMPTS) return false;
  const remaining = row.expiresAt.getTime() - now.getTime();
  return remaining >= REGISTRATION_REMINDER_MIN_REMAINING_MS && remaining <= REGISTRATION_REMINDER_MAX_REMAINING_MS;
}

type Claim = { id: string; email: string; link: string; locale: EmailLocale; theme: Partial<EmailTheme> | undefined };

/**
 * Decides and claims under the per-address lock that completing a registration takes
 * (`lockRegistrationIdentity`), so a registration that finishes at this moment is either seen as
 * finished here or finishes after the claim. Verifying the e-mail code takes the per-row lock
 * (`lockRegistration`), not this one, so the claim's own `where` also guards `emailVerifiedAt` and
 * `browserAuthorizedAt`. The claim commits before anything is sent: two sweeps, or two instances,
 * can never both send.
 */
async function claimReminder(id: string, prisma: PrismaClient, now: Date, isBanned: typeof isPrincipalBannedForRegistration): Promise<Claim | null> {
  const first = await prisma.pendingRegistration.findUnique({ where: { id }, select: { emailHash: true } });
  if (!first) return null;
  return runInTransaction(prisma, async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('pending-registration-email'), hashtext(${first.emailHash}))::text AS "lockResult"`;
    const row = await tx.pendingRegistration.findUnique({ where: { id } });
    if (!row || !isReminderDue(row, now)) return null;
    // An address gets one reminder, and only for its newest live registration: a resend is the
    // same person, not a second one to remind.
    const siblings = await tx.pendingRegistration.findFirst({
      where: {
        id: { not: row.id }, emailHash: row.emailHash, domain: row.domain, expiresAt: { gt: now },
        AND: { OR: [{ completedAt: { not: null } }, { reminderSentAt: { not: null } }, { expiresAt: { gt: row.expiresAt } }] },
      },
      select: { id: true },
    });
    if (siblings) return null;
    const token = await tx.verificationToken.findUnique({ where: { tokenHash: row.completionHash } });
    if (!token || token.type !== 'VERIFY_EMAIL_SET_PASSWORD' || token.usedAt || token.userId !== null ||
      token.expiresAt.getTime() <= now.getTime() || !(await readVerificationTokenEpoch(tx, token))) return null;
    // The epoch check above already answers this; an account made some other way since sign-up
    // (OAuth, an invite) is checked outright too, so no reminder depends on a single guard.
    if (await tx.user.findUnique({ where: { userKey: token.userKey }, select: { id: true } })) return null;
    if (await isBanned({ domain: row.domain, email: token.email, ip: null }, { prisma: tx })) return null;
    const linkToken = registrationSecret();
    const claimed = await tx.pendingRegistration.updateMany({
      where: {
        id: row.id, reminderSentAt: null, completedAt: null, emailVerifiedAt: null, browserAuthorizedAt: null,
        expiresAt: { gt: now },
      },
      data: { reminderSentAt: now, reminderLinkHash: registrationDigest('link', linkToken) },
    });
    if (claimed.count !== 1) return null;
    const link = new URL('/auth/registration/link', getPublicBaseUrl());
    link.hash = linkToken;
    return {
      id: row.id, email: token.email, link: link.toString(),
      locale: row.locale === 'cs' ? 'cs' : 'en',
      theme: (row.emailTheme ?? undefined) as Partial<EmailTheme> | undefined,
    };
  });
}

export async function sweepRegistrationReminders(deps?: RegistrationReminderDeps): Promise<RegistrationReminderSweep> {
  const result: RegistrationReminderSweep = { claimed: 0, sent: 0, failed: 0 };
  const clock = deps?.now ?? (() => new Date());
  const listedAt = clock();
  if (!isReminderSendTime(listedAt)) return result;
  const prisma = deps?.prisma ?? getAdminPrisma();
  const candidates = await prisma.pendingRegistration.findMany({
    where: {
      completedAt: null, emailVerifiedAt: null, browserAuthorizedAt: null, reminderSentAt: null,
      attempts: { lt: REGISTRATION_MAX_ATTEMPTS },
      expiresAt: {
        gte: new Date(listedAt.getTime() + REGISTRATION_REMINDER_MIN_REMAINING_MS),
        lte: new Date(listedAt.getTime() + REGISTRATION_REMINDER_MAX_REMAINING_MS),
      },
    } satisfies Prisma.PendingRegistrationWhereInput,
    select: { id: true },
    // Closest to expiry first, so a long list cannot cost the rows with least time left. Rows that
    // can never be reminded are not marked; they would have to number more than 500 in the window
    // to crowd the others out, which is not realistic at current volume.
    orderBy: { expiresAt: 'asc' },
    take: 500,
  });
  for (const { id } of candidates) {
    // A sweep can run past 19:00, and the due check and `reminderSentAt` use the time of the claim.
    const now = clock();
    if (!isReminderSendTime(now)) break;
    const claim = await claimReminder(id, prisma, now, deps?.isBanned ?? isPrincipalBannedForRegistration);
    if (!claim) continue;
    result.claimed += 1;
    // Never retried: the claim stays, and at most one reminder is better than a second one.
    // The log carries the row id only, never the address.
    try {
      const delivered = await (deps?.send ?? sendRegistrationReminderEmail)({
        to: claim.email, link: claim.link, theme: claim.theme, locale: claim.locale,
      });
      if (delivered === false) throw new Error('REMINDER_NOT_ACCEPTED');
      result.sent += 1;
    } catch {
      result.failed += 1;
      deps?.log?.warn({ registrationId: claim.id }, 'registration reminder was not sent');
    }
  }
  return result;
}
