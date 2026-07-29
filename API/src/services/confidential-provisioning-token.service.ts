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
import { hasOwnKey } from '../utils/untrusted-record.js';
import type { AccessTokenActorHop, AccessTokenClaims } from './access-token.service.js';
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

/** Maximum `act` depth accepted, matching the chained exchange that writes it. */
const MAX_ACTOR_CHAIN_DEPTH = 8;

/**
 * The `act` delegation chain written by
 * `confidential-chained-token-exchange.service.ts`. Recursive, so it is declared
 * with an explicit type annotation rather than inferred.
 */
const ActorChainSchema: z.ZodType<ActorChain> = z.lazy(() =>
  z
    .object({
      sub: z.string().trim().min(1).max(256),
      product: z.string().trim().regex(PRODUCT_PATTERN),
      act: ActorChainSchema.optional(),
    })
    .strict(),
);

type ActorChain = {
  sub: string;
  product: string;
  act?: ActorChain;
};

/** Flatten `act` to a bounded list, immediate caller first. */
function flattenActorChain(actor: ActorChain | undefined): AccessTokenActorHop[] {
  const hops: AccessTokenActorHop[] = [];
  let current = actor;
  while (current && hops.length < MAX_ACTOR_CHAIN_DEPTH) {
    hops.push({ sub: current.sub, product: current.product });
    current = current.act;
  }
  // A chain deeper than the minting service will ever produce is malformed.
  if (current) throw invalidConfidentialToken();
  return hops;
}

/**
 * The identity domain the token's `org`/`active` claims were resolved under.
 *
 * On a direct exchange there is no `act`, so this is simply `source_domain`. On a
 * chained exchange the org context is re-resolved under the ORIGINAL signed
 * origin at the tail of `act` while `source_domain` names the latest hop, so the
 * two can legitimately differ — see the same-domain assertion in
 * `verifySignedClaims`.
 */
function originalIdentityDomain(sourceDomain: string, actor: ActorChain | undefined): string {
  let domain = sourceDomain;
  let current = actor;
  while (current) {
    domain = current.sub;
    current = current.act;
  }
  return domain;
}

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
    // Present only on a token produced by the chained exchange.
    act: ActorChainSchema.optional(),
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

  // Load the verification keys OUTSIDE the catch-all below.
  //
  // `getAccessTokenPublicJwks()` throws `MCP_OAUTH_DISABLED` (500) when
  // `MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK` is unset and `MCP_OAUTH_KEY_INVALID`
  // (500) when it is malformed. Both are SERVER faults — the service cannot
  // verify anything — and must not be laundered into a 401 that tells a caller
  // its perfectly good token was rejected. A client that sees 401 discards the
  // token and re-exchanges, so a signing-key outage would become a retry storm
  // that looks like a credential problem. Let the 5xx propagate.
  const jwks = createLocalJWKSet(await (deps.getAccessTokenJwks ?? getAccessTokenPublicJwks)());

  try {
    if (!isConfidentialProvisioningTokenCandidate(token)) throw invalidConfidentialToken();

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
        // Own-property lookup: a bare `team_roles[teamId]` would resolve
        // `Object.prototype` members, so `teamId: "constructor"` would satisfy
        // this check without the token ever carrying that team.
        !hasOwnKey(parsed.org.team_roles, parsed.active.teamId)
      ) {
        throw invalidConfidentialToken();
      }

      // Same-identity-domain binding. On the HS256 path `claims.domain` and
      // `claims.org` are same-domain by construction — the org context is read
      // from the user's session on that one domain. A CHAINED confidential token
      // breaks that: `confidential-chained-token-exchange.service.ts` re-resolves
      // the org under the ORIGINAL signed origin at the tail of `act`, but stamps
      // the LATEST hop into `source_domain`/`azp`. Such a token would therefore
      // present an org minted under domain A while claiming domain B.
      //
      // Nothing downstream is exploitable today (every `/org` handler resolves
      // through `resolveOrganisationByDomain` filtered on the request domain, and
      // the RLS `app.domain` GUC scopes the rows underneath), but that is a
      // property of the handlers, not of this middleware — so assert it here
      // rather than depending on it. A cross-domain org could only ever produce a
      // confusing 404 downstream; an explicit reject is the honest answer.
      if (originalIdentityDomain(sourceDomain, parsed.act) !== sourceDomain) {
        throw invalidConfidentialToken();
      }
    }

    // Bound the chain depth even when there is no org claim to check.
    flattenActorChain(parsed.act);

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

  // DB-authoritative checks. Unlike the HS256 verifier — which may skip its lookup
  // in DB-less boot mode because a token that predates the users table can still
  // identify a user — this path FAILS CLOSED without a database. Two reasons:
  //
  //  1. The DB reads below are not only revocation. `DomainRole` is an
  //     *authorization* gate (the acting user must still hold a role on the source
  //     domain), so skipping it would accept a validly-signed token for a user who
  //     was de-roled — strictly more permissive than the HS256 path, which never
  //     grants authority the DB has withdrawn.
  //  2. `/org/*` cannot serve a request without a database anyway: every org
  //     service calls `assertDatabaseEnabled` and raises this same
  //     `DATABASE_DISABLED` 500. Failing here changes only *which* layer reports the
  //     misconfiguration, never a request that would otherwise have succeeded.
  //
  // This is deliberately a 500, not a 401: a missing database is a server
  // misconfiguration, and a 401 here would look to the caller like a logout.
  const prisma =
    deps.prisma ??
    (getEnv().DATABASE_URL
      ? (getAdminPrisma() as unknown as ConfidentialProvisioningPrisma)
      : undefined);
  if (!prisma) throw new AppError('INTERNAL', 500, 'DATABASE_DISABLED');

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
  const role: 'superuser' | 'user' = domainRole.role === 'SUPERUSER' ? 'superuser' : 'user';

  // Actor provenance. Without this the org audit log records only `actorUserId`,
  // making a product backend acting FOR a user indistinguishable from the user
  // acting themselves — the wrong default for a feature whose entire purpose is
  // acting on someone's behalf. `product` and `act` are already carried by the
  // token; they are surfaced here rather than dropped.
  const chain = flattenActorChain(parsed.act);

  return {
    userId: parsed.sub,
    tokenVersion: parsed.tv,
    email: parsed.email,
    domain: sourceDomain,
    clientId: parsed.azp,
    role,
    actor: {
      via: 'confidential_provisioning',
      product: parsed.product,
      sourceDomain,
      ...(chain.length ? { chain } : {}),
    },
    ...(parsed.org ? { org: parsed.org } : {}),
    ...(parsed.active ? { active: parsed.active } : {}),
  };
}
