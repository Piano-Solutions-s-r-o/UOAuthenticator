import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import { machineActor, writeAuditLog } from '../../src/services/audit-log.service.js';

describe('writeAuditLog', () => {
  it('writes a row with actor, action, target and metadata', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'log-1' });
    const prisma = { adminAuditLog: { create } } as unknown as PrismaClient;

    await writeAuditLog(
      {
        actorEmail: 'admin@example.com',
        action: 'integration.declined',
        targetDomain: 'client.example.com',
        metadata: { integrationRequestId: 'req-1', reason: 'spam' },
      },
      { prisma },
    );

    expect(create).toHaveBeenCalledWith({
      data: {
        actorEmail: 'admin@example.com',
        action: 'integration.declined',
        targetDomain: 'client.example.com',
        metadata: { integrationRequestId: 'req-1', reason: 'spam' },
      },
    });
  });

  it('defaults metadata to empty object and targetDomain to null', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'log-1' });
    const prisma = { adminAuditLog: { create } } as unknown as PrismaClient;

    await writeAuditLog({ actorEmail: 'admin@example.com', action: 'jwk.added' }, { prisma });

    expect(create).toHaveBeenCalledWith({
      data: {
        actorEmail: 'admin@example.com',
        action: 'jwk.added',
        targetDomain: null,
        metadata: {},
      },
    });
  });
});

describe('machineActor', () => {
  it('names the calling backend and its client id', () => {
    expect(machineActor({ domain: 'client.example.com', clientId: 'cli_1' })).toBe(
      'client:client.example.com#cli_1',
    );
  });

  it('omits the client id when the request carried none', () => {
    expect(machineActor({ domain: 'client.example.com' })).toBe('client:client.example.com');
    expect(machineActor({ domain: 'client.example.com', clientId: null })).toBe(
      'client:client.example.com',
    );
  });

  it('never produces a value a reader could mistake for an email address', () => {
    // `/internal/admin/*` rows carry a real operator address. A machine row must be
    // distinguishable at a glance and unmatchable against any address.
    const actor = machineActor({ domain: 'client.example.com', clientId: 'cli_1' });

    expect(actor.startsWith('client:')).toBe(true);
    expect(actor).not.toMatch(/^[^@\s:]+@[^@\s:]+$/);
  });
});
