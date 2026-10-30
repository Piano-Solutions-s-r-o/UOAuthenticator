import { beforeEach, describe, expect, it, vi } from 'vitest';

// HUGO-2261: two simultaneous confirmations of one link both read the row before either takes the
// advisory lock. The funnel outcome must come from the locked row, not from that earlier read.
const mocks = vi.hoisted(() => ({ funnel: vi.fn(), publish: vi.fn() }));
vi.mock('../../src/services/auth-funnel.service.js', () => ({ recordAuthFunnelStep: mocks.funnel }));
vi.mock('../../src/services/registration-events.service.js', () => ({ publishRegistrationChange: mocks.publish }));

import { verifyPendingRegistrationLink } from '../../src/services/pending-registration.service.js';

function fakePrisma(beforeLock: { linkUsedAt: Date | null }, underLock: { linkUsedAt: Date | null }) {
  const base = { id: 'reg-1', domain: 'client.example.com', expiresAt: new Date(Date.now() + 60_000), attempts: 0, emailVerifiedAt: null, restartUrl: null };
  const update = vi.fn().mockResolvedValue({ count: 2 });
  // No $transaction: runInTransaction runs the body on this client, like inside a tenant transaction.
  const prisma = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    pendingRegistration: {
      findUnique: vi.fn()
        .mockResolvedValueOnce({ ...base, ...beforeLock })
        .mockResolvedValueOnce({ ...base, ...underLock }),
      findMany: vi.fn().mockResolvedValue([{ id: 'reg-1' }, { id: 'reg-2' }]),
      updateMany: update,
    },
  };
  return { prisma, update };
}

describe('verifyPendingRegistrationLink funnel outcome', () => {
  beforeEach(() => {
    process.env.SHARED_SECRET = 'test-shared-secret-for-registration-digests';
    mocks.funnel.mockReset(); mocks.publish.mockReset();
  });

  it('counts already_used when another confirmation won the lock after this one read the row', async () => {
    const { prisma, update } = fakePrisma({ linkUsedAt: null }, { linkUsedAt: new Date() });
    await verifyPendingRegistrationLink('a'.repeat(43), prisma as never);
    expect(update).not.toHaveBeenCalled();
    expect(mocks.funnel).toHaveBeenCalledTimes(1);
    expect(mocks.funnel.mock.calls[0][0]).toMatchObject({ step: 'email_link_opened', outcome: 'already_used' });
  });

  it('counts registration_verified when this confirmation is the one that approves the flow', async () => {
    const { prisma, update } = fakePrisma({ linkUsedAt: null }, { linkUsedAt: null });
    await verifyPendingRegistrationLink('a'.repeat(43), prisma as never);
    expect(update).toHaveBeenCalledTimes(1);
    expect(mocks.funnel).toHaveBeenCalledTimes(1);
    expect(mocks.funnel.mock.calls[0][0]).toMatchObject({ step: 'email_link_opened', outcome: 'registration_verified' });
    // A window waiting on the newer registration has to hear about it at once, not at its next poll.
    expect(mocks.publish.mock.calls.map(([id]) => id)).toEqual(['reg-1', 'reg-2']);
  });
});
