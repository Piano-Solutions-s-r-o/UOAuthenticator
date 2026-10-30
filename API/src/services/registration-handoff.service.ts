import type { PrismaClient } from '@prisma/client';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { getPublicBaseUrl } from '../config/env.js';
import { parsePkceChallenge } from '../utils/pkce.js';
import type { ClientConfig } from './config.service.js';
import { registrationConfigHash } from './pending-registration.service.js';
import { equalRegistrationDigest, registrationCookieName, registrationDigest, REGISTRATION_HANDOFF_TTL_MS, REGISTRATION_MAX_ATTEMPTS } from './registration-credentials.js';
import { readVerificationTokenEpoch } from './verification-token-epoch.service.js';

export const REGISTRATION_HANDOFF_COOKIE = 'uoa_registration_handoff';

const HANDOFF_VALUE = /^([0-9a-f-]{36})\.(\d+)\.(\d+)$/;

export type RegistrationHandoff = { email: string; tokenHash: string; originalBrowser: boolean } | { completed: true };

function cookieOptions() {
  return {
    httpOnly: true, secure: new URL(getPublicBaseUrl()).protocol === 'https:',
    sameSite: 'lax' as const, path: '/auth', signed: true,
  };
}

/**
 * Proof that this browser opened a registration's emailed link. It holds no secret and no address,
 * only which registration, so the verification token stays on the server. Host-only and Lax: it
 * leaves with the redirect to the product and comes back on the top-level navigation to /auth.
 */
export function setRegistrationHandoffCookie(reply: FastifyReply, id: string, registrationExpiresAt: Date): void {
  const now = Date.now();
  const expiresAt = Math.min(now + REGISTRATION_HANDOFF_TTL_MS, registrationExpiresAt.getTime());
  reply.setCookie(REGISTRATION_HANDOFF_COOKIE, `${id}.${now}.${expiresAt}`, {
    ...cookieOptions(), maxAge: Math.floor((expiresAt - now) / 1000),
  });
}

export function clearRegistrationHandoffCookie(reply: FastifyReply): void {
  reply.clearCookie(REGISTRATION_HANDOFF_COOKIE, cookieOptions());
}

function handoffRegistrationId(request: FastifyRequest): string | null {
  const raw = request.cookies?.[REGISTRATION_HANDOFF_COOKIE];
  if (!raw) return null;
  const unsigned = request.unsignCookie(raw);
  const match = unsigned.valid && unsigned.value ? HANDOFF_VALUE.exec(unsigned.value) : null;
  return match && Number(match[3]) > Date.now() ? match[1] : null;
}

/** A password form without the product's own fresh PKCE could not sign anyone in (HUGO-1961). */
export function hasS256Challenge(query: unknown): boolean {
  const { code_challenge: codeChallenge, code_challenge_method: codeChallengeMethod } = (query ?? {}) as Record<string, unknown>;
  if (typeof codeChallenge !== 'string' || typeof codeChallengeMethod !== 'string') return false;
  try {
    return parsePkceChallenge({ codeChallenge, codeChallengeMethod }) !== undefined;
  } catch {
    return false;
  }
}

/**
 * The registration this browser may finish, or null when anything does not hold. The caller's PKCE
 * and redirect are its own: only the product's exact signed config has to match the row.
 */
export async function resolveRegistrationHandoff(
  params: { request: FastifyRequest; config: ClientConfig; configUrl: string },
  prisma: PrismaClient,
): Promise<RegistrationHandoff | null> {
  const id = handoffRegistrationId(params.request);
  if (!id) return null;
  const now = Date.now();
  const row = await prisma.pendingRegistration.findUnique({ where: { id } });
  if (!row || row.domain !== params.config.domain ||
    !equalRegistrationDigest(registrationConfigHash(params.configUrl, params.config), row.configHash)) return null;
  // The other browser won: this one holds a valid link, so it may hear that, and no more.
  if (row.completedAt) return { completed: true };
  if (row.expiresAt.getTime() <= now || row.attempts >= REGISTRATION_MAX_ATTEMPTS) return null;
  const token = await prisma.verificationToken.findUnique({ where: { tokenHash: row.completionHash } });
  if (!token || token.type !== 'VERIFY_EMAIL_SET_PASSWORD' || token.usedAt || token.expiresAt.getTime() <= now ||
    !(await readVerificationTokenEpoch(prisma, token))) return null;
  // The link opened in another tab of the browser that started: that window must not also go in.
  const credential = params.request.cookies?.[registrationCookieName(row.id)];
  const originalBrowser = Boolean(credential) && equalRegistrationDigest(registrationDigest('browser', credential ?? ''), row.credentialHash);
  return { email: token.email, tokenHash: row.completionHash, originalBrowser };
}
