import type { FastifyRequest } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClientConfig } from '../../src/services/config.service.js';
import { registrationConfigHash } from '../../src/services/pending-registration.service.js';
import { REGISTRATION_HANDOFF_COOKIE, resolveRegistrationHandoff } from '../../src/services/registration-handoff.service.js';

const id = '9466e365-206c-49cb-a8d5-aa1342bdd613';
const configUrl = 'https://client.example.com/auth-config';
const config = { domain: 'client.example.com', login_flow: { registration_code_enabled: true } } as unknown as ClientConfig;
const later = () => new Date(Date.now() + 60_000);

function row(overrides: Record<string, unknown> = {}) {
  return {
    id, domain: 'client.example.com', configHash: registrationConfigHash(configUrl, config), completionHash: 'stored-hash',
    expiresAt: later(), attempts: 0, completedAt: null, ...overrides,
  };
}
function token(overrides: Record<string, unknown> = {}) {
  return {
    type: 'VERIFY_EMAIL_SET_PASSWORD', email: 'person@example.com', expiresAt: later(), usedAt: null,
    userId: null, tokenVersion: null, userKey: 'person@example.com', ...overrides,
  };
}

function request(value: string | undefined, valid = true) {
  return {
    cookies: value === undefined ? {} : { [REGISTRATION_HANDOFF_COOKIE]: `${value}.signature` },
    unsignCookie: (raw: string) => (valid ? { valid: true, renew: false, value: raw.replace(/\.signature$/, '') } : { valid: false, renew: false, value: null }),
  } as unknown as FastifyRequest;
}

function prisma(pending: unknown, verification: unknown, user: unknown = null) {
  return {
    pendingRegistration: { findUnique: vi.fn().mockResolvedValue(pending) },
    verificationToken: { findUnique: vi.fn().mockResolvedValue(verification) },
    user: { findUnique: vi.fn().mockResolvedValue(user) },
  };
}

const value = () => `${id}.${Date.now()}.${Date.now() + 60_000}`;
const resolve = (client: ReturnType<typeof prisma>, from = request(value()), activeConfig = config) =>
  resolveRegistrationHandoff({ request: from, config: activeConfig, configUrl }, client as never);

beforeEach(() => { process.env.SHARED_SECRET = 'test-shared-secret-for-registration-digests'; });

describe('resolveRegistrationHandoff', () => {
  it('answers the address and the stored token hash, never a token', async () => {
    expect(await resolve(prisma(row(), token()))).toEqual({ email: 'person@example.com', tokenHash: 'stored-hash' });
  });

  it.each([
    ['no cookie', undefined],
    ['a malformed value', 'not-a-handoff'],
    ['another shape of id', `abc.${Date.now()}.${Date.now() + 60_000}`],
    ['a value past its own expiry', `${id}.1000.2000`],
  ])('refuses %s without a query', async (_name, cookie) => {
    const client = prisma(row(), token());
    expect(await resolve(client, request(cookie))).toBeNull();
    expect(client.pendingRegistration.findUnique).not.toHaveBeenCalled();
  });

  it('refuses a bad signature without a query', async () => {
    const client = prisma(row(), token());
    expect(await resolve(client, request(value(), false))).toBeNull();
    expect(client.pendingRegistration.findUnique).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing row', null],
    ['a completed row', row({ completedAt: new Date() })],
    ['an expired row', row({ expiresAt: new Date(0) })],
    ['an exhausted row', row({ attempts: 5 })],
    ['another domain with a matching config hash', row({ domain: 'other.example.com' })],
    ['another config', row({ configHash: 'x'.repeat(64) })],
  ])('refuses %s', async (_name, pending) => {
    expect(await resolve(prisma(pending, token()))).toBeNull();
  });

  it.each([
    ['a missing token', null],
    ['a login-link token', token({ type: 'LOGIN_LINK' })],
    ['a passwordless token', token({ type: 'VERIFY_EMAIL' })],
    ['a used token', token({ usedAt: new Date() })],
    ['an expired token', token({ expiresAt: new Date(0) })],
  ])('refuses %s', async (_name, verification) => {
    expect(await resolve(prisma(row(), verification))).toBeNull();
  });

  it('refuses once an account owns the address', async () => {
    expect(await resolve(prisma(row(), token(), { id: 'user' }))).toBeNull();
  });
});
