import type { ClientConfig } from './config.service.js';

import { getPrisma } from '../db/prisma.js';
import {
  type AccessRequestPrisma,
  getEnv,
  normalizeAccessRequestStatus,
  toAccessRequestRecord,
  ensureUserAssignedToConfiguredAccessTarget,
  assertDatabaseEnabled,
  resolveConfiguredAccessTarget,
} from './access-request.service.base.js';
import { normalizeDomain } from '../utils/domain.js';
import { AppError } from '../utils/errors.js';
import { auditOrg } from './organisation.service.base.js';

type AccessRequestAdminDeps = {
  env?: ReturnType<typeof getEnv>;
  prisma?: AccessRequestPrisma;
  now?: () => Date;
};

export async function listAccessRequests(params: {
  orgId: string;
  teamId: string;
  config: ClientConfig;
  status?: string;
}, deps?: AccessRequestAdminDeps): Promise<{ data: ReturnType<typeof toAccessRequestRecord>[] }> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);
  const prisma = deps?.prisma ?? (getPrisma() as AccessRequestPrisma);
  // Binds the path ids to the CALLING domain — the config-only check they used
  // to get is authored by the caller and is not a tenant boundary.
  await resolveConfiguredAccessTarget({
    prisma,
    config: params.config,
    orgId: params.orgId,
    teamId: params.teamId,
  });
  const status = normalizeAccessRequestStatus(params.status);
  const rows = await prisma.accessRequest.findMany({
    where: {
      orgId: params.orgId,
      teamId: params.teamId,
      status,
    },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      orgId: true,
      teamId: true,
      email: true,
      requestName: true,
      status: true,
      requestedAt: true,
      lastRequestedAt: true,
      reviewedAt: true,
      reviewReason: true,
      notifiedAt: true,
      createdAt: true,
      updatedAt: true,
      userId: true,
      reviewedByUserId: true,
    },
  });

  const domain = normalizeDomain(params.config.domain);
  return { data: rows.map((row) => toAccessRequestRecord(row, domain)) };
}

async function findRequestOrThrow(params: {
  prisma: AccessRequestPrisma;
  requestId: string;
  orgId: string;
  teamId: string;
}) {
  const row = await params.prisma.accessRequest.findFirst({
    where: {
      id: params.requestId,
      orgId: params.orgId,
      teamId: params.teamId,
    },
    select: {
      id: true,
      orgId: true,
      teamId: true,
      email: true,
      requestName: true,
      status: true,
      requestedAt: true,
      lastRequestedAt: true,
      reviewedAt: true,
      reviewReason: true,
      notifiedAt: true,
      createdAt: true,
      updatedAt: true,
      userId: true,
      reviewedByUserId: true,
    },
  });
  if (!row) throw new AppError('NOT_FOUND', 404);
  return row;
}

export async function approveAccessRequest(params: {
  orgId: string;
  teamId: string;
  requestId: string;
  config: ClientConfig;
  reviewedByUserId?: string;
  reviewReason?: string;
}, deps?: AccessRequestAdminDeps): Promise<ReturnType<typeof toAccessRequestRecord>> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);
  const prisma = deps?.prisma ?? (getPrisma() as AccessRequestPrisma);
  // Binds the path ids to the CALLING domain — the config-only check they used
  // to get is authored by the caller and is not a tenant boundary.
  await resolveConfiguredAccessTarget({
    prisma,
    config: params.config,
    orgId: params.orgId,
    teamId: params.teamId,
  });
  const now = deps?.now ? deps.now() : new Date();
  const row = await findRequestOrThrow({
    prisma,
    requestId: params.requestId,
    orgId: params.orgId,
    teamId: params.teamId,
  });
  if (row.status === 'APPROVED') {
    return toAccessRequestRecord(row, normalizeDomain(params.config.domain));
  }

  if (row.userId) {
    await ensureUserAssignedToConfiguredAccessTarget({
      prisma,
      config: params.config,
      userId: row.userId,
      now,
    });
  }

  const updated = await prisma.accessRequest.update({
    where: { id: row.id },
    data: {
      status: 'APPROVED',
      reviewedAt: now,
      reviewedByUserId: params.reviewedByUserId?.trim() || null,
      reviewReason: params.reviewReason?.trim() || null,
    },
    select: {
      id: true,
      orgId: true,
      teamId: true,
      email: true,
      requestName: true,
      status: true,
      requestedAt: true,
      lastRequestedAt: true,
      reviewedAt: true,
      reviewReason: true,
      notifiedAt: true,
      createdAt: true,
      updatedAt: true,
      userId: true,
      reviewedByUserId: true,
    },
  });

  await auditAccessRequestReview({
    action: 'access_request.approved',
    orgId: params.orgId,
    config: params.config,
    row: updated,
    reviewedByUserId: params.reviewedByUserId,
    prisma,
  });

  return toAccessRequestRecord(updated, normalizeDomain(params.config.domain));
}

export async function rejectAccessRequest(params: {
  orgId: string;
  teamId: string;
  requestId: string;
  config: ClientConfig;
  reviewedByUserId?: string;
  reviewReason?: string;
}, deps?: AccessRequestAdminDeps): Promise<ReturnType<typeof toAccessRequestRecord>> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);
  const prisma = deps?.prisma ?? (getPrisma() as AccessRequestPrisma);
  // Binds the path ids to the CALLING domain — the config-only check they used
  // to get is authored by the caller and is not a tenant boundary.
  await resolveConfiguredAccessTarget({
    prisma,
    config: params.config,
    orgId: params.orgId,
    teamId: params.teamId,
  });
  const now = deps?.now ? deps.now() : new Date();
  const row = await findRequestOrThrow({
    prisma,
    requestId: params.requestId,
    orgId: params.orgId,
    teamId: params.teamId,
  });

  const updated = await prisma.accessRequest.update({
    where: { id: row.id },
    data: {
      status: 'REJECTED',
      reviewedAt: now,
      reviewedByUserId: params.reviewedByUserId?.trim() || null,
      reviewReason: params.reviewReason?.trim() || null,
    },
    select: {
      id: true,
      orgId: true,
      teamId: true,
      email: true,
      requestName: true,
      status: true,
      requestedAt: true,
      lastRequestedAt: true,
      reviewedAt: true,
      reviewReason: true,
      notifiedAt: true,
      createdAt: true,
      updatedAt: true,
      userId: true,
      reviewedByUserId: true,
    },
  });

  await auditAccessRequestReview({
    action: 'access_request.rejected',
    orgId: params.orgId,
    config: params.config,
    row: updated,
    reviewedByUserId: params.reviewedByUserId,
    prisma,
  });

  return toAccessRequestRecord(updated, normalizeDomain(params.config.domain));
}

/**
 * Record an access-request review (brief 24.8).
 *
 * These routes authenticate on the domain pairing alone - domain-hash bearer
 * plus verified config, never a user token - so the reviewer is ALWAYS the
 * domain backend and the row carries `actorUserId: null` with `uoa_actor`
 * provenance.
 *
 * `reviewedByUserId` is a caller-supplied label, not an authenticated actor, so
 * it stays in metadata and must never be promoted to `actorUserId`.
 */
async function auditAccessRequestReview(params: {
  action: 'access_request.approved' | 'access_request.rejected';
  orgId: string;
  config: ClientConfig;
  row: { id: string; teamId: string; userId: string | null };
  reviewedByUserId?: string;
  prisma: AccessRequestPrisma;
}): Promise<void> {
  await auditOrg(
    {
      orgId: params.orgId,
      actorUserId: undefined,
      actor: { via: 'domain_backend', sourceDomain: normalizeDomain(params.config.domain) },
      action: params.action,
      targetType: 'access_request',
      targetId: params.row.id,
      metadata: {
        teamId: params.row.teamId,
        requestUserId: params.row.userId,
        reviewedByUserId: params.reviewedByUserId?.trim() || null,
      },
    },
    { prisma: params.prisma },
  );
}
