import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import {
  ORG_AUDIT_ACTOR_METADATA_KEY,
  writeOrgAuditLog,
} from '../../src/services/org-audit-log.service.js';

describe('writeOrgAuditLog', () => {
  it('writes a row with org, actor, action, target and metadata', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'oal-1' });
    const prisma = { orgAuditLog: { create } } as unknown as PrismaClient;

    await writeOrgAuditLog(
      {
        orgId: 'org-1',
        actorUserId: 'user-1',
        action: 'member.deactivated',
        targetType: 'org_member',
        targetId: 'member-1',
        metadata: { userId: 'user-2', role: 'admin' },
      },
      { prisma },
    );

    expect(create).toHaveBeenCalledWith({
      data: {
        orgId: 'org-1',
        actorUserId: 'user-1',
        action: 'member.deactivated',
        targetType: 'org_member',
        targetId: 'member-1',
        metadata: { userId: 'user-2', role: 'admin' },
      },
    });
  });

  it('defaults actorUserId to null (system write) and metadata to empty object', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'oal-2' });
    const prisma = { orgAuditLog: { create } } as unknown as PrismaClient;

    await writeOrgAuditLog(
      {
        orgId: 'org-1',
        action: 'invite.accepted',
        targetType: 'invite',
        targetId: 'inv-1',
      },
      { prisma },
    );

    expect(create).toHaveBeenCalledWith({
      data: {
        orgId: 'org-1',
        actorUserId: null,
        action: 'invite.accepted',
        targetType: 'invite',
        targetId: 'inv-1',
        metadata: {},
      },
    });
  });

  // A domain backend acting on its own must be distinguishable from a user
  // acting. Without this a backend-initiated mutation is indistinguishable from a
  // system write, which is exactly the attribution gap this key closes.
  it('records backend actor provenance under the reserved metadata key', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'oal-3' });
    const prisma = { orgAuditLog: { create } } as unknown as PrismaClient;

    await writeOrgAuditLog(
      {
        orgId: 'org-1',
        actorUserId: 'user-1',
        actor: {
          via: 'domain_backend',
          sourceDomain: 'api.hugopos.eu',
        },
        action: 'member.added',
        targetType: 'org_member',
        targetId: 'member-9',
        metadata: { userId: 'user-2', role: 'member' },
      },
      { prisma },
    );

    expect(create).toHaveBeenCalledWith({
      data: {
        orgId: 'org-1',
        actorUserId: 'user-1',
        action: 'member.added',
        targetType: 'org_member',
        targetId: 'member-9',
        metadata: {
          userId: 'user-2',
          role: 'member',
          [ORG_AUDIT_ACTOR_METADATA_KEY]: {
            via: 'domain_backend',
            source_domain: 'api.hugopos.eu',
          },
        },
      },
    });
  });

  // Caller metadata must never be able to forge or overwrite provenance.
  it('does not let caller metadata shadow the reserved actor key', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'oal-4' });
    const prisma = { orgAuditLog: { create } } as unknown as PrismaClient;

    await writeOrgAuditLog(
      {
        orgId: 'org-1',
        actorUserId: 'user-1',
        actor: {
          via: 'domain_backend',
          sourceDomain: 'api.hugopos.eu',
        },
        action: 'member.added',
        targetType: 'org_member',
        targetId: 'member-9',
        metadata: { [ORG_AUDIT_ACTOR_METADATA_KEY]: { via: 'spoofed' } },
      },
      { prisma },
    );

    expect(create.mock.calls[0][0].data.metadata[ORG_AUDIT_ACTOR_METADATA_KEY]).toEqual({
      via: 'domain_backend',
      source_domain: 'api.hugopos.eu',
    });
  });

  // A user-initiated write must stay byte-identical to before the feature: no
  // reserved key at all, so "absent" unambiguously means "the user did it".
  it('omits the actor key entirely for a user-initiated write', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'oal-5' });
    const prisma = { orgAuditLog: { create } } as unknown as PrismaClient;

    await writeOrgAuditLog(
      {
        orgId: 'org-1',
        actorUserId: 'user-1',
        action: 'member.added',
        targetType: 'org_member',
        targetId: 'member-9',
        metadata: { userId: 'user-2' },
      },
      { prisma },
    );

    expect(create.mock.calls[0][0].data.metadata).toEqual({ userId: 'user-2' });
  });
});
