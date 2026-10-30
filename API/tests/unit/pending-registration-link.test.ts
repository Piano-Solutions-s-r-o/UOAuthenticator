import { beforeEach, describe, expect, it, vi } from 'vitest';

// HUGO-2261: two simultaneous opens of one link both read the row before either takes the advisory
// lock. The funnel outcome must come from the locked row, not from that earlier read.
const mocks = vi.hoisted(() => ({ funnel: vi.fn(), publish: vi.fn() }));
vi.mock('../../src/services/auth-funnel.service.js', () => ({ recordAuthFunnelStep: mocks.funnel }));
vi.mock('../../src/services/registration-events.service.js', () => ({ publishRegistrationChange: mocks.publish }));

import { openPendingRegistrationLink } from '../../src/services/pending-registration.service.js';

const FUTURE = () => new Date(Date.now() + 60_000);

function fakePrisma(beforeLock: Record<string, unknown>, underLock: Record<string, unknown>, tokenOverrides: Record<string, unknown> = {}) {
  const base = {
    id: 'reg-1', domain: 'client.example.com', expiresAt: FUTURE(), attempts: 0, completionHash: 'hash',
    linkUsedAt: null, completedAt: null, loginRestartUrl: 'https://a.example/login?start=1',
    registrationRestartUrl: 'https://a.example/login?start=1&signup=1',
  };
  const update = vi.fn().mockResolvedValue({});
  const token = {
    type: 'VERIFY_EMAIL_SET_PASSWORD', expiresAt: FUTURE(), usedAt: null, userId: null, tokenVersion: null,
    userKey: 'a@b.cz', ...tokenOverrides,
  };
  // No $transaction: runInTransaction runs the body on this client, like inside a tenant transaction.
  const prisma = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    pendingRegistration: {
      findUnique: vi.fn().mockResolvedValueOnce({ ...base, ...beforeLock }).mockResolvedValueOnce({ ...base, ...underLock }),
      update,
    },
    verificationToken: { findUnique: vi.fn().mockResolvedValue(token) },
    user: { findUnique: vi.fn().mockResolvedValue(null) },
  };
  return { prisma, update };
}

describe('openPendingRegistrationLink', () => {
  beforeEach(() => {
    process.env.SHARED_SECRET = 'test-shared-secret-for-registration-digests';
    mocks.funnel.mockReset(); mocks.publish.mockReset();
  });

  it('counts already_used when another open won the lock after this one read the row', async () => {
    const { prisma, update } = fakePrisma({ linkUsedAt: null }, { linkUsedAt: new Date() });
    const result = await openPendingRegistrationLink('a'.repeat(43), prisma as never);
    expect(result.status).toBe('continue');
    expect(update).not.toHaveBeenCalled();
    expect(mocks.funnel).toHaveBeenCalledTimes(1);
    expect(mocks.funnel.mock.calls[0][0]).toMatchObject({ step: 'email_link_opened', outcome: 'already_used' });
  });

  it('counts opened the first time, and writes nothing except when it was opened', async () => {
    const { prisma, update } = fakePrisma({ linkUsedAt: null }, { linkUsedAt: null });
    await openPendingRegistrationLink('a'.repeat(43), prisma as never);
    expect(update).toHaveBeenCalledExactlyOnceWith({ where: { id: 'reg-1' }, data: { linkUsedAt: expect.any(Date) } });
    expect(mocks.funnel.mock.calls[0][0]).toMatchObject({ step: 'email_link_opened', outcome: 'opened' });
  });

  it('wakes no window: opening a link changes nothing a window can see', async () => {
    const { prisma } = fakePrisma({ linkUsedAt: null }, { linkUsedAt: null });
    await openPendingRegistrationLink('a'.repeat(43), prisma as never);
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('answers the row\'s own next step for each outcome', async () => {
    const login = 'https://a.example/login?start=1';
    const registration = 'https://a.example/login?start=1&signup=1';
    const open = (under: Record<string, unknown>, token: Record<string, unknown> = {}) =>
      openPendingRegistrationLink('a'.repeat(43), fakePrisma({}, under, token).prisma as never);
    expect(await open({})).toMatchObject({ status: 'continue', next: registration, id: 'reg-1' });
    expect(await open({ completedAt: new Date() })).toEqual({ status: 'complete', next: login });
    expect(await open({}, { type: 'LOGIN_LINK', userId: 'u', tokenVersion: 0 })).toEqual({ status: 'complete', next: login });
    expect(await open({}, { usedAt: new Date() })).toEqual({ status: 'complete', next: login });
    expect(await open({ expiresAt: new Date(0) })).toEqual({ status: 'expired', next: registration });
    expect(await open({ attempts: 5 })).toEqual({ status: 'expired', next: registration });
    expect(await open({}, { expiresAt: new Date(0) })).toEqual({ status: 'expired', next: registration });
  });

  it('counts an expired link as expired and marks nothing', async () => {
    const { prisma, update } = fakePrisma({}, { expiresAt: new Date(0) });
    await openPendingRegistrationLink('a'.repeat(43), prisma as never);
    expect(update).not.toHaveBeenCalled();
    expect(mocks.funnel.mock.calls[0][0]).toMatchObject({ step: 'email_link_opened', outcome: 'expired' });
  });

  it('prefers complete over expired, so a finished registration is never told to start again', async () => {
    const { prisma } = fakePrisma({}, { completedAt: new Date(), expiresAt: new Date(0) });
    expect((await openPendingRegistrationLink('a'.repeat(43), prisma as never)).status).toBe('complete');
  });
});
