import type { Prisma, PrismaClient } from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';

/**
 * Org-scoped audit log (design §4.10). Distinct from the platform-admin `AdminAuditLog`
 * (audit-log.service.ts), which is keyed by operator email for `/internal/admin/*` actions.
 *
 * Rows are written from membership / invite / policy mutations. Two write paths:
 *
 *   1. Tenant-scoped write — pass the request's transaction client (`prisma`). The row is inserted
 *      in the SAME transaction as the mutation it records, under the uoa_app role. RLS requires
 *      `org_id` to equal the request's `app.org_id`, so only pass the tx client for a mutation that
 *      is already scoped to `orgId`.
 *   2. System write — omit `prisma`. Uses the BYPASSRLS admin client for actions with no tenant
 *      context (auto-enrolment, later SCIM), where `actorUserId` is null.
 */

export type OrgAuditTargetType =
  | 'org_member'
  | 'team_member'
  | 'invite'
  | 'invite_link'
  | 'team'
  | 'organisation';

export type OrgAuditAction =
  // Membership lifecycle (§4.5)
  | 'member.added'
  | 'member.removed'
  | 'member.role_changed'
  | 'member.deactivated'
  | 'member.reactivated'
  | 'team_member.added'
  | 'team_member.removed'
  | 'team_member.role_changed'
  // Invites (§4.7)
  | 'invite.created'
  | 'invite.resent'
  | 'invite.revoked'
  | 'invite.accepted'
  | 'invite.declined'
  | 'invite.approved'
  | 'invite.denied'
  | 'invite_link.created'
  | 'invite_link.revoked'
  // Policy / settings (§4.6)
  | 'team.join_policy_changed'
  | 'org.member_invites_changed';

export type OrgAuditLogPrisma = Pick<PrismaClient, 'orgAuditLog'>;

/**
 * Provenance of an `/org/*` mutation that the product backend for a domain made
 * itself, rather than a signed-in user making it.
 *
 * `undefined` means user-initiated — the shape every request carrying an
 * `x-uoa-access-token` produces, and the only shape that existed before backend
 * mode. It is populated exactly when `requireOrgRole` accepted the request on the
 * domain pairing alone (domain-hash bearer + verified config JWT, no user token);
 * see `middleware/org-role-guard.ts`.
 *
 * There is no acting user in that mode, so an audit row written for it carries
 * `actorUserId: null` and this provenance instead — "the backend for domain X did
 * this", never a user who did not act.
 */
export type OrgActorProvenance = {
  /** Which acceptance path produced this call. One value today, kept for forward-compat. */
  via: 'domain_backend';
  /** The verified config domain the calling backend was authenticated as. */
  sourceDomain: string;
};

export type WriteOrgAuditLogParams = {
  orgId: string;
  action: OrgAuditAction;
  targetType: OrgAuditTargetType;
  targetId: string;
  actorUserId?: string | null;
  /**
   * Provenance of the domain backend that made this mutation itself. Undefined
   * for every user-initiated mutation, which is every mutation that arrived with
   * an `x-uoa-access-token`.
   */
  actor?: OrgActorProvenance;
  metadata?: Prisma.InputJsonValue;
};

/**
 * Reserved `metadata` key holding backend-actor provenance.
 *
 * `OrgAuditLog` has no dedicated actor column and adding one would mean a schema
 * migration on a production auth service; `metadata` is already a `Json` column
 * with a `{}` default, so provenance rides there under one reserved key. Rows
 * without the key are user-initiated — including every row written before this
 * feature existed, which stays true without a backfill.
 */
export const ORG_AUDIT_ACTOR_METADATA_KEY = 'uoa_actor';

/** Serialise actor provenance into the reserved metadata key. */
function actorMetadata(
  actor: OrgActorProvenance | undefined,
): Record<string, Prisma.InputJsonValue> | undefined {
  if (!actor) return undefined;
  return {
    [ORG_AUDIT_ACTOR_METADATA_KEY]: {
      via: actor.via,
      source_domain: actor.sourceDomain,
    },
  };
}

/**
 * Merge caller metadata with actor provenance.
 *
 * Callers always pass a plain object, but `Prisma.InputJsonValue` also admits
 * scalars and arrays, so guard before spreading and fall back to the provenance
 * alone rather than silently discarding it.
 */
function buildMetadata(params: WriteOrgAuditLogParams): Prisma.InputJsonValue {
  const provenance = actorMetadata(params.actor);
  const base = params.metadata ?? {};
  if (!provenance) return base;
  const isPlainObject = typeof base === 'object' && base !== null && !Array.isArray(base);
  // Provenance last so caller metadata can never shadow the reserved key.
  return isPlainObject
    ? { ...(base as Record<string, Prisma.InputJsonValue>), ...provenance }
    : provenance;
}

/**
 * Write an org audit row. Pass `deps.prisma` (the tenant transaction client) to record it inside a
 * scoped mutation; omit it for a system write via the BYPASSRLS admin client.
 */
export async function writeOrgAuditLog(
  params: WriteOrgAuditLogParams,
  deps?: { prisma?: OrgAuditLogPrisma },
): Promise<void> {
  const prisma = deps?.prisma ?? (getAdminPrisma() as unknown as OrgAuditLogPrisma);

  await prisma.orgAuditLog.create({
    data: {
      orgId: params.orgId,
      actorUserId: params.actorUserId ?? null,
      action: params.action,
      targetType: params.targetType,
      targetId: params.targetId,
      metadata: buildMetadata(params),
    },
  });
}
