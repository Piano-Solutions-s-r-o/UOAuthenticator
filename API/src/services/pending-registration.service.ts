import { randomUUID } from 'node:crypto';

import type { PendingRegistration, PrismaClient } from '@prisma/client';

import { getPublicBaseUrl } from '../config/env.js';
import { runInTransaction } from '../db/tenant-context.js';
import { AppError } from '../utils/errors.js';
import { hashEmailToken } from '../utils/verification-token.js';
import { requireEnv } from '../config/env.js';
import { requestRegistrationInstructions, type RegistrationDelivery } from './auth-register.service.js';
import { recordAuthFunnelStep } from './auth-funnel.service.js';
import type { ClientConfig } from './config.service.js';
import { resolveEmailContinuation } from './email-continuation.service.js';
import type { EmailLocale } from './email.templates.js';
import { fingerprintClientConfig } from './login-session.service.js';
import { lockProductWorkspacePolicyShared } from './product-workspace-policy-lock.service.js';
import { readVerificationTokenEpoch } from './verification-token-epoch.service.js';
import {
  completionToken, equalRegistrationDigest, registrationCode, registrationCookieName,
  registrationDigest, registrationSecret, REGISTRATION_CONTINUE_TTL_MS, REGISTRATION_MAX_ATTEMPTS,
  REGISTRATION_TOKEN_PREFIX, REGISTRATION_TTL_MS,
} from './registration-credentials.js';
import { publishRegistrationChange } from './registration-events.service.js';

export type RegistrationContext = {
  config: ClientConfig;
  configUrl: string;
  redirectUrl?: string;
  codeChallenge?: string;
  codeChallengeMethod?: 'S256';
  requestAccess?: boolean;
};

function contextHash(context: RegistrationContext): string {
  return registrationDigest('context', JSON.stringify([
    context.configUrl, fingerprintClientConfig(context.config), context.redirectUrl ?? null,
    context.codeChallenge ?? null, context.codeChallengeMethod ?? null,
    context.requestAccess === true,
  ]));
}

/** The product's exact signed config. Unlike contextHash it leaves out PKCE and the callback, which belong to one browser. */
export function registrationConfigHash(configUrl: string, config: ClientConfig): string {
  return registrationDigest('config', JSON.stringify([configUrl, fingerprintClientConfig(config)]));
}

function refuse(): never {
  throw new AppError('BAD_REQUEST', 400, 'REGISTRATION_UNAVAILABLE');
}

function assertBrowser(row: PendingRegistration | null, credential: string, context: RegistrationContext): asserts row is PendingRegistration {
  if (!row || !credential || !equalRegistrationDigest(registrationDigest('browser', credential), row.credentialHash) ||
    !equalRegistrationDigest(contextHash(context), row.contextHash)) refuse();
}

/**
 * A resend proves the browser with the cookie of the registration it replaces and keeps that cookie's
 * secret, because the OAuth context alone is public URL data. Anything else starts a separate browser.
 */
async function resendCredential(params: RegistrationContext & { email: string | null; previous?: { id: string; credential: string } }, prisma: PrismaClient): Promise<string | null> {
  if (!params.previous?.credential) return null;
  const row = await prisma.pendingRegistration.findUnique({ where: { id: params.previous.id } });
  if (!row || !equalRegistrationDigest(registrationDigest('browser', params.previous.credential), row.credentialHash) ||
    !equalRegistrationDigest(contextHash(params), row.contextHash) ||
    !equalRegistrationDigest(registrationDigest('email', params.email ?? ''), row.emailHash)) return null;
  return params.previous.credential;
}

export async function startPendingRegistration(params: RegistrationContext & { email: string | null; ip?: string; locale?: EmailLocale; previous?: { id: string; credential: string } }, prisma: PrismaClient) {
  const registrationRestartUrl = params.config.registration_restart_url;
  if (!registrationRestartUrl) refuse();
  const id = randomUUID();
  const credential = await resendCredential(params, prisma) ?? registrationSecret();
  const linkToken = registrationSecret();
  const code = registrationCode();
  const expiresAt = new Date(Date.now() + REGISTRATION_TTL_MS);
  const token = completionToken(id, credential);
  await prisma.pendingRegistration.create({ data: {
    id, domain: params.config.domain, credentialHash: registrationDigest('browser', credential),
    linkHash: registrationDigest('link', linkToken), codeHash: registrationDigest('code', `${id}:${code}`),
    completionHash: hashEmailToken(token, requireEnv('SHARED_SECRET').SHARED_SECRET),
    contextHash: contextHash(params), configHash: registrationConfigHash(params.configUrl, params.config),
    emailHash: registrationDigest('email', params.email ?? ''),
    loginRestartUrl: params.config.login_restart_url ?? null, registrationRestartUrl, expiresAt,
  } });
  let status: 'sent' | 'existing_user' = 'sent';
  let delivery: RegistrationDelivery | undefined;
  if (params.email) {
    const link = new URL('/auth/registration/link', getPublicBaseUrl());
    // Fragment credentials never enter HTTP access logs or referrers. The isolated
    // landing page removes the fragment before it posts the secret.
    link.hash = linkToken;
    const result = await requestRegistrationInstructions({
      ...params, email: params.email,
      browserRegistration: { completionToken: token, code, link: link.toString(), expiresAt },
    }, { prisma });
    status = result.status;
    if (result.status === 'sent') delivery = result.delivery;
  }
  return { id, credential, expiresAt, status, delivery };
}

export async function pendingRegistrationState(params: RegistrationContext & { id: string; credential: string }, prisma: PrismaClient) {
  const row = await prisma.pendingRegistration.findUnique({ where: { id: params.id } });
  assertBrowser(row, params.credential, params);
  // First, because a resend family finishes together: an exhausted or older sibling is still done.
  if (row.completedAt) return { status: 'complete' as const };
  if (row.expiresAt.getTime() <= Date.now() || row.attempts >= REGISTRATION_MAX_ATTEMPTS) {
    return { status: 'expired' as const };
  }
  if (!row.browserAuthorizedAt) return { status: 'pending' as const };
  const tokenRow = await prisma.verificationToken.findUnique({ where: { tokenHash: row.completionHash } });
  if (!tokenRow || tokenRow.expiresAt.getTime() <= Date.now()) return { status: 'expired' as const };
  if (tokenRow.usedAt) return { status: 'complete' as const };
  if (!(await readVerificationTokenEpoch(prisma, tokenRow))) return { status: 'expired' as const };
  return { status: 'authorized' as const, token: completionToken(row.id, params.credential), token_type: tokenRow.type };
}

async function lockRegistration(prisma: PrismaClient, id: string) {
  await prisma.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('pending-registration'), hashtext(${id}))::text AS "lockResult"`;
  return prisma.pendingRegistration.findUnique({ where: { id } });
}

export async function verifyPendingRegistrationCode(params: RegistrationContext & { id: string; credential: string; code: string }, prisma: PrismaClient): Promise<void> {
  const accepted = await runInTransaction(prisma, async tx => {
    const row = await lockRegistration(tx, params.id);
    assertBrowser(row, params.credential, params);
    const now = new Date();
    if (row.completedAt) return true; // The state the caller reads next says complete.
    if (row.expiresAt <= now || row.attempts >= REGISTRATION_MAX_ATTEMPTS) return false;
    if (row.browserAuthorizedAt) return true;
    if (!equalRegistrationDigest(registrationDigest('code', `${row.id}:${params.code}`), row.codeHash)) {
      await tx.pendingRegistration.update({ where: { id: row.id }, data: { attempts: { increment: 1 } } });
      return false; // Commit failed guesses before the public error is thrown.
    }
    await tx.pendingRegistration.update({ where: { id: row.id }, data: {
      emailVerifiedAt: row.emailVerifiedAt ?? now, browserAuthorizedAt: now,
    } });
    return true;
  });
  if (!accepted) refuse();
  publishRegistrationChange(params.id);
}

export type RegistrationLinkOutcome =
  | { status: 'continue'; next: string; id: string; expiresAt: Date }
  | { status: 'complete'; next: string | null }
  | { status: 'expired'; next: string };

async function linkStatus(row: PendingRegistration, prisma: PrismaClient): Promise<RegistrationLinkOutcome['status']> {
  if (row.completedAt) return 'complete';
  const now = Date.now();
  if (row.expiresAt.getTime() <= now || row.attempts >= REGISTRATION_MAX_ATTEMPTS) return 'expired';
  const token = await prisma.verificationToken.findUnique({ where: { tokenHash: row.completionHash } });
  if (!token || token.expiresAt.getTime() <= now) return 'expired';
  // An account now owns this address, or it already existed: there is nothing to set up here.
  if (token.usedAt || token.type !== 'VERIFY_EMAIL_SET_PASSWORD' || !(await readVerificationTokenEpoch(prisma, token))) return 'complete';
  return 'continue';
}

/**
 * Opening a link approves nothing and creates nothing: a mail scanner that runs the page only gets a
 * cookie in its own browser. The password is what finishes a registration. The row answers where the
 * page goes next, because this request has no verified config of its own.
 */
export async function openPendingRegistrationLink(token: string, prisma: PrismaClient): Promise<RegistrationLinkOutcome> {
  const initial = await prisma.pendingRegistration.findUnique({ where: { linkHash: registrationDigest('link', token) } });
  if (!initial) refuse();
  // Decided under the lock, so two simultaneous opens count one first open.
  const { row, status } = await runInTransaction(prisma, async tx => {
    const locked = await lockRegistration(tx, initial.id);
    if (!locked) refuse();
    const decided = await linkStatus(locked, tx);
    if (decided !== 'expired' && !locked.linkUsedAt) {
      await tx.pendingRegistration.update({ where: { id: locked.id }, data: { linkUsedAt: new Date() } });
    }
    return { row: locked, status: decided };
  });
  await recordAuthFunnelStep({ domain: row.domain, step: 'email_link_opened',
    outcome: status === 'expired' ? 'expired' : row.linkUsedAt ? 'already_used' : 'opened' }, { prisma });
  if (status === 'continue') return { status, next: row.registrationRestartUrl, id: row.id, expiresAt: row.expiresAt };
  if (status === 'expired') return { status, next: row.registrationRestartUrl };
  return { status, next: row.loginRestartUrl };
}

/**
 * `/auth/verify-email` remains the account and session writer for this flow, and this check ties a
 * token to the original browser. `/auth/email/link` can also consume a `registration.` token, but
 * that token is only ever handed to the browser that already holds the cookie. The browser that
 * opened the link never receives one (`registration-handoff.service.ts`).
 */
export async function assertPendingRegistrationCompletion(params: RegistrationContext & { token: string; cookies: Record<string, string | undefined> }, prisma: PrismaClient): Promise<void> {
  if (!params.token.startsWith(REGISTRATION_TOKEN_PREFIX)) return;
  const row = await prisma.pendingRegistration.findUnique({ where: {
    completionHash: hashEmailToken(params.token, requireEnv('SHARED_SECRET').SHARED_SECRET),
  } });
  if (!row) refuse();
  assertBrowser(row, params.cookies[registrationCookieName(row.id)] ?? '', params);
  if (!row.browserAuthorizedAt || row.expiresAt.getTime() <= Date.now()) refuse();
}

/**
 * The original window, after its registration finished somewhere else. It proved the browser and the
 * exact context when it started; the password set elsewhere is the rest of the proof, and only for a
 * short while. Everything is decided under the row lock, once, and the code is bound to this window's
 * own PKCE by the same continuation an ordinary verification runs. Polling never gets a code.
 */
export async function continuePendingRegistration(
  params: RegistrationContext & { id: string; credential: string; ip: string | null },
  prisma: PrismaClient,
) {
  return runInTransaction(prisma, async tx => {
    await lockProductWorkspacePolicyShared(tx);
    const row = await lockRegistration(tx, params.id);
    assertBrowser(row, params.credential, params);
    if (!row.completedAt || !row.completedUserId || row.completedEpoch === null ||
      Date.now() - row.completedAt.getTime() > REGISTRATION_CONTINUE_TTL_MS) refuse();
    const user = await tx.user.findUnique({ where: { id: row.completedUserId }, select: { twoFaEnabled: true } });
    if (!user) refuse();
    // Once for the whole family, whichever of its registrations asks. Only finished rows count: a
    // resend after completion is a row of this family that must not reopen the claim.
    const claimed = await tx.pendingRegistration.updateMany({
      where: {
        credentialHash: row.credentialHash, contextHash: row.contextHash, emailHash: row.emailHash,
        completedAt: { not: null }, continuedAt: null,
      },
      data: { continuedAt: new Date() },
    });
    if (!claimed.count) refuse();
    const verified = {
      userId: row.completedUserId, credentialEpoch: row.completedEpoch, twoFaEnabled: user.twoFaEnabled,
      acceptedInvite: null, authMethod: 'verify_email_set_password',
    };
    const continuation = await resolveEmailContinuation({
      ...verified, config: params.config, configUrl: params.configUrl, requestedRedirectUrl: params.redirectUrl,
      requestAccess: params.requestAccess === true, codeChallenge: params.codeChallenge,
      codeChallengeMethod: params.codeChallengeMethod, ip: params.ip,
    }, tx);
    return { continuation, userId: row.completedUserId, authMethod: verified.authMethod };
  });
}
