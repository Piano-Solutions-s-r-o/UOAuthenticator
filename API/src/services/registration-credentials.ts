import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

import { REGISTRATION_EMAIL_TOKEN_TTL_MS } from '../config/constants.js';
import { requireEnv } from '../config/env.js';

// One lifetime for the link, the code, the HttpOnly cookie and the pending row (HUGO-2261): the
// same constant HUGO-1636 set for every registration email, so nothing can expire earlier than
// the email says.
export const REGISTRATION_TTL_MS = REGISTRATION_EMAIL_TOKEN_TTL_MS;
export const REGISTRATION_MAX_ATTEMPTS = 5;
export const REGISTRATION_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const REGISTRATION_TOKEN_PREFIX = 'registration.';
// How long a browser that opened a link may finish from it, and how long after the password was set
// the original window may still go in by itself.
export const REGISTRATION_HANDOFF_TTL_MS = 60 * 60 * 1000;
// A row outlives its link: it is the only thing that knows where someone with an old email restarts.
export const REGISTRATION_EXPIRED_RETENTION_DAYS = 30;
export const REGISTRATION_CONTINUE_TTL_MS = 15 * 60 * 1000;

export function registrationDigest(kind: string, value: string): string {
  return createHmac('sha256', requireEnv('SHARED_SECRET').SHARED_SECRET)
    .update(`registration:${kind}:${value}`).digest('hex');
}

export function registrationSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function registrationCode(): string {
  return Array.from({ length: 6 }, () => REGISTRATION_ALPHABET[randomInt(REGISTRATION_ALPHABET.length)]).join('');
}

export function equalRegistrationDigest(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function completionToken(id: string, credential: string): string {
  return `${REGISTRATION_TOKEN_PREFIX}${registrationDigest('completion', `${id}:${credential}`)}`;
}

export function registrationCookieName(id: string): string {
  return `uoa_registration_${id}`;
}
