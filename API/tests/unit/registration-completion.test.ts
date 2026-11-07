import { describe, expect, it, vi } from 'vitest';

import { completeRegistrationFamily, lockRegistrationIdentity } from '../../src/services/registration-completion.service.js';

const family = { credentialHash: 'browser', contextHash: 'context', emailHash: 'address' };

type Row = Record<string, string>;

function prisma(row: Row | null = family, ids: string[] = ['older', 'newer']) {
  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
    pendingRegistration: {
      // Answers only what was selected, like the database: the family is what the query asks for.
      findUnique: vi.fn(async ({ select }: { select: Record<string, boolean> }) =>
        row && Object.fromEntries(Object.keys(select).map(key => [key, row[key]]))),
      findMany: vi.fn().mockResolvedValue(ids.map(id => ({ id }))),
      updateMany: vi.fn().mockResolvedValue({ count: ids.length }),
    },
  };
}
const now = new Date('2026-10-30T12:00:00.000Z');
const complete = (client: ReturnType<typeof prisma>, continued: boolean) =>
  completeRegistrationFamily(client as never, { tokenHash: 'hash', userId: 'user', credentialEpoch: 3, continued, now });

describe('completeRegistrationFamily', () => {
  it('selects by browser, context and address together, and only unfinished rows', async () => {
    const client = prisma();
    await complete(client, false);
    expect(client.pendingRegistration.findMany).toHaveBeenCalledWith({ select: { id: true }, where: { ...family, completedAt: null } });
  });

  it('records who finished and at which credential epoch, and leaves the continuation open', async () => {
    const client = prisma();
    expect(await complete(client, false)).toEqual(['older', 'newer']);
    expect(client.pendingRegistration.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['older', 'newer'] } },
      data: { completedAt: now, completedUserId: 'user', completedEpoch: 3 },
    });
  });

  it('closes the continuation when the original window finished itself', async () => {
    const client = prisma();
    await complete(client, true);
    expect(client.pendingRegistration.updateMany.mock.calls[0][0].data).toMatchObject({ continuedAt: now });
  });

  it('does nothing for a token that belongs to no registration', async () => {
    const client = prisma(null);
    expect(await complete(client, false)).toEqual([]);
    expect(client.pendingRegistration.updateMany).not.toHaveBeenCalled();
  });
});

describe('lockRegistrationIdentity', () => {
  it('takes no lock for a token that belongs to no registration', async () => {
    const client = prisma(null);
    await lockRegistrationIdentity(client as never, 'hash');
    expect(client.$queryRaw).not.toHaveBeenCalled();
  });
});
