// Resource-side verification of a confidential RFC 8693 provisioning token so a
// trusted product backend can act on `/org/*` for one of its users without ever
// holding that user's HS256 session token.
//
// This is the mirror image of `confidential-token-exchange.service.ts`: that file
// MINTS the RS256 `at+jwt` (issuer = this service's public base URL, audience =
// the delegation `resource`, `source_domain`/`azp` = the verified source domain);
// this file VERIFIES one presented back to UOA's own `/org/*` routes. It never
// widens what the exchange already decided — the token must still be
// domain-bound, scope-bound, resource-bound, and epoch-current, and the org/team
// authorization that follows is the unchanged `requireOrgRole` logic.
import type { PrismaClient } from '@prisma/client';
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';
import { z } from 'zod';

import { getEnv, getPublicBaseUrl } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import { normalizeDomain } from '../utils/domain.js';
import { AppError } from '../utils/errors.js';
import type { AccessTokenClaims } from './access-token.service.js';
import { CONFIDENTIAL_ASSERTION_CLOCK_TOLERANCE_SECONDS } from './confidential-assertion-use.service.js';
import { parseConfidentialDelegationScope } from './confidential-delegation.service.js';
import { CONFIDENTIAL_ACCESS_TOKEN_TTL_SECONDS } from './confidential-token-exchange.service.js';
import { getAccessTokenPublicJwks } from './oauth/access-token.service.js';

const PRODUCT_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/;

/** The delegation scope a token must carry to act on `/org/*`. */
export const ORG_PROVISIONING_SCOPE = 'token.provision';

/**
 * Path segment appended to this service's public base URL to form the audience
 * (RFC 8707 `resource`) an org-provisioning token must be bound to. A delegation
 * mapping that wants org access is therefore registered with
 * `resource = "<PUBLIC_BASE_URL>/org"` exactly — no other resource URI, and no
 * prefix/suffix tolerance, grants `/org/*`.
 */
export const ORG_PROVISIONING_RESOURCE_PATH = '/org';

/** The exact `aud` an org-provisioning token must carry. */
export function getOrgProvisioningAudience(): string {
  return `${getPublicBaseUrl()}${ORG_PROVISIONING_RESOURCE_PATH}`;
}

const ActiveWorkspaceSchema = z
  .object({
    orgId: z.string().trim().min(1).max(256),
    teamId: z.string().trim().min(1).max(256),
  })
  .strict();

const OrgContextSchema = z
  .object({
    org_id: z.string().trim().min(1).max(256),
    org_role: z.string().trim().min(1).max(100),
    teams: z.array(z.string().trim().min(1).max(256)).min(1),
    team_roles: z.record(z.string().trim().min(1).max(100)),
    groups: z.array(z.string().trim().min(1).max(256)).optional(),
    group_admin: z.array(z.string().trim().min(1).max(256)).optional(),
  })
  .strict();

// Shape of a token produced by `signConfidentialAccessToken`. `org`/`active` are
// present only when the original exchange assertion selected a workspace, so both
// are optional here — but never one without the other (checked below).
const ConfidentialProvisioningTokenSchema = z
  .object({
    iss: z.string().trim().min(1),
    aud: z.string().trim().min(1),
    sub: z.string().trim().min(1).max(256),
    tv: z.number().int().nonnegative(),
    email: z.string().trim().min(1),
    source_domain: z.string().trim().min(1),
    azp: z.string().trim().min(1),
    product: z.string().trim().regex(PRODUCT_PATTERN),
    scope: z.string().trim().min(1).max(256),
    jti: z.string().trim().min(1).max(256),
    iat: z.number().int().positive(),
    exp: z.number().int().positive(),
    active: ActiveWorkspaceSchema.optional(),
    org: OrgContextSchema.optional(),
  })
  .passthrough();

type ConfidentialProvisioningPrisma = Pick<PrismaClient, 'user' | 'domainRole'>;

export type ConfidentialProvisioningDeps = {
  prisma?: ConfidentialProvisioningPrisma;
  now?: () => number;
  issuer?: string;
  audience?: string;
  getAccessTokenJwks?: typeof getAccessTokenPublicJwks;
};

function invalidConfidentialToken(): AppError {
  return new AppError('UNAUTHORIZED', 401, 'CONFIDENTIAL_TOKEN_INVALID');
}

/**
 * Cheap, signature-free shape test used to decide whether a token that failed
 * HS256 user-token verification is even a candidate for the confidential path.
 * Deterministic: only an RS256 `at+jwt` — the exact protected header
 * `signConfidentialAccessToken` writes — is ever routed here.
 */
export function isConfidentialProvisioningTokenCandidate(token: string): boolean {
  try {
    const header = decodeProtectedHeader(token);
    return (
      header.alg === 'RS256' &&
      header.typ === 'at+jwt' &&
      typeof header.kid === 'string' &&
      header.kid.trim().length > 0
    );
  } catch {
    return false;
  }
}

async function verifySignedClaims(
  token: string,
  deps: ConfidentialProvisioningDeps,
): Promise<z.infer<typeof ConfidentialProvisioningTokenSchema>> {
  const now = deps.now?.() ?? Math.floor(Date.now() / 1000);
  const issuer = deps.issuer ?? getPublicBaseUrl();
  const audience = deps.audience ?? getOrgProvisioningAudience();

  try {
    if (!isConfidentialProvisioningTokenCandidate(token)) throw invalidConfidentialToken();

    const jwks = createLocalJWKSet(await (deps.getAccessTokenJwks ?? getAccessTokenPublicJwks)());
    const { payload } = await jwtVerify(token, jwks, {
      algorithms: ['RS256'],
      typ: 'at+jwt',
      issuer,
      audience,
      clockTolerance: CONFIDENTIAL_ASSERTION_CLOCK_TOLERANCE_SECONDS,
      currentDate: new Date(now * 1000),
    });

    const parsed = ConfidentialProvisioningTokenSchema.parse(payload);
    const sourceDomain = normalizeDomain(parsed.source_domain);
    // Canonical scope form (sorted, de-duplicated, allowlisted) — the exact string
    // the exchange signs. Anything else is a forged or mangled token, not a
    // narrower grant.
    const scopes = parseConfidentialDelegationScope(parsed.scope);

    if (
      parsed.iss !== issuer ||
      // `jwtVerify` already accepted the audience; re-assert the exact string so a
      // multi-valued `aud` array can never satisfy an org-provisioning token.
      parsed.aud !== audience ||
      !sourceDomain ||
      parsed.source_domain !== sourceDomain ||
      parsed.azp !== sourceDomain ||
      parsed.exp <= parsed.iat ||
      parsed.exp - parsed.iat > CONFIDENTIAL_ACCESS_TOKEN_TTL_SECONDS ||
      parsed.iat > now + CONFIDENTIAL_ASSERTION_CLOCK_TOLERANCE_SECONDS ||
      parsed.exp <= now ||
      scopes.join(' ') !== parsed.scope
    ) {
      throw invalidConfidentialToken();
    }

    // `org` and `active` are minted together or not at all; a token carrying one
    // without the other (or an `active` team outside its own org context) is
    // malformed, never a partially-scoped grant.
    if (Boolean(parsed.org) !== Boolean(parsed.active)) throw invalidConfidentialToken();
    if (parsed.org && parsed.active) {
      const uniqueTeams = new Set(parsed.org.teams);
      if (
        parsed.org.org_id !== parsed.active.orgId ||
        uniqueTeams.size !== parsed.org.teams.length ||
        !uniqueTeams.has(parsed.active.teamId) ||
        !parsed.org.team_roles[parsed.active.teamId]
      ) {
        throw invalidConfidentialToken();
      }
    }

    return parsed;
  } catch {
    // Never leak which check failed, and never log token material.
    throw invalidConfidentialToken();
  }
}

/**
 * Verify a confidential `token.provision` access token and project it onto the
 * exact `AccessTokenClaims` shape the HS256 user path produces, so every
 * downstream org/team authorization decision is unchanged.
 *
 * Deliberate differences from a user token, all in the restrictive direction:
 * - `role` comes from the live `DomainRole` row (the token carries none) and the
 *   platform-superuser escalation is NOT applied, so a confidential token is
 *   never more privileged than the same user's HS256 token.
 * - `clientId` is the non-secret source domain (`azp`); confidential tokens
 *   deliberately never carry a `client_id`.
 */
export async function verifyConfidentialProvisioningToken(
  params: { token: string; domain: string },
  deps: ConfidentialProvisioningDeps = {},
): Promise<AccessTokenClaims> {
  const parsed = await verifySignedClaims(params.token, deps);
  const sourceDomain = normalizeDomain(parsed.source_domain);

  // Same binding the HS256 path enforces through `claims.domain`: a token minted
  // for one product domain can never act on another domain's tenant.
  const requestDomain = normalizeDomain(params.domain);
  if (!requestDomain || sourceDomain !== requestDomain) {
    throw new AppError('FORBIDDEN', 403, 'CONFIDENTIAL_TOKEN_DOMAIN_MISMATCH');
  }

  const scopes = new Set(parsed.scope.split(' ').filter(Boolean));
  if (!scopes.has(ORG_PROVISIONING_SCOPE)) {
    throw new AppError('FORBIDDEN', 403, 'CONFIDENTIAL_SCOPE_MISSING');
  }

  // DB-authoritative revocation, mirroring `verifyAccessToken`: a signature and an
  // unexpired `exp` are not enough once the user's credential epoch moves. DB-less
  // boot mode has no users table, so the lookup is skipped there exactly as the
  // HS256 verifier does.
  const prisma =
    deps.prisma ??
    (getEnv().DATABASE_URL
      ? (getAdminPrisma() as unknown as ConfidentialProvisioningPrisma)
      : undefined);

  let role: 'superuser' | 'user' = 'user';
  if (prisma) {
    const [user, domainRole] = await Promise.all([
      prisma.user.findUnique({ where: { id: parsed.sub }, select: { tokenVersion: true } }),
      prisma.domainRole.findUnique({
        where: { domain_userId: { domain: sourceDomain, userId: parsed.sub } },
        select: { role: true },
      }),
    ]);

    // Keep user existence and the current epoch opaque, exactly as the HS256 path
    // does. Unexpected DB failures propagate as 5xx rather than a false 401.
    if (!user || user.tokenVersion !== parsed.tv) throw invalidConfidentialToken();
    // The acting user must still hold a role on the source domain — the same
    // condition the exchange required before it minted this token.
    if (!domainRole) throw new AppError('FORBIDDEN', 403, 'CONFIDENTIAL_DOMAIN_ROLE_MISSING');
    role = domainRole.role === 'SUPERUSER' ? 'superuser' : 'user';
  }

  return {
    userId: parsed.sub,
    tokenVersion: parsed.tv,
    email: parsed.email,
    domain: sourceDomain,
    clientId: parsed.azp,
    role,
    ...(parsed.org ? { org: parsed.org } : {}),
    ...(parsed.active ? { active: parsed.active } : {}),
  };
}
