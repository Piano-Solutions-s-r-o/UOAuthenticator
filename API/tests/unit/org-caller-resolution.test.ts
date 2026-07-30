// The guardrail pair that makes "optional acting user" safe.
//
// Backend mode means an `/org/*` service can legitimately run with no
// `actorUserId`. The failure mode that creates is a dropped parameter silently
// becoming unauthenticated access, so two things must hold and are pinned here:
//
//   * `resolveOrgActor` (service side) refuses params that carry NEITHER an
//     acting user nor backend provenance — that is a programming error, not a
//     backend call;
//   * `orgCaller` (route side) can only produce the no-user branch from
//     `request.orgBackendCaller`, which `requireOrgRole` is the sole writer of.
import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';

import { orgCaller, tenantUserId } from '../../src/routes/org/organisation-route.shared.js';
import { resolveOrgActor } from '../../src/services/organisation.service.base.js';
import type { OrgActorProvenance } from '../../src/services/org-audit-log.service.js';

const backendActor: OrgActorProvenance = {
  via: 'domain_backend',
  sourceDomain: 'api.hugopos.eu',
};

describe('resolveOrgActor', () => {
  it('returns the trimmed acting user when one is given', () => {
    expect(resolveOrgActor({ actorUserId: '  user_1  ' })).toBe('user_1');
  });

  // Both set describes two mutually exclusive callers. Silently preferring one
  // would let `writeOrgAuditLog` record a row claiming a user AND the domain
  // backend performed the same mutation — a self-contradictory audit trail on a
  // production auth service. `orgCaller` never produces this shape, so it is a
  // programming error and gets the same loud 500 as neither-set.
  it('raises a 500 when an acting user and backend provenance are both present', () => {
    expect(() => resolveOrgActor({ actorUserId: 'user_1', actor: backendActor })).toThrowError(
      expect.objectContaining({
        code: 'INTERNAL',
        statusCode: 500,
        message: 'ORG_ACTOR_AMBIGUOUS',
      }),
    );
  });

  it('returns undefined for a backend call', () => {
    expect(resolveOrgActor({ actor: backendActor })).toBeUndefined();
  });

  // The whole point of the guardrail: neither means the caller forgot to pass
  // one, and that must be loud rather than an authorization bypass.
  it('raises a 500 when neither an acting user nor provenance is given', () => {
    expect(() => resolveOrgActor({})).toThrowError(
      expect.objectContaining({
        code: 'INTERNAL',
        statusCode: 500,
        message: 'ORG_ACTOR_UNRESOLVED',
      }),
    );
  });

  // An explicitly-empty string is a malformed value, not an absent one. This is
  // the pre-existing contract and must not silently become backend mode.
  it('keeps the historical BAD_REQUEST for an explicitly empty acting user', () => {
    expect(() => resolveOrgActor({ actorUserId: '' })).toThrowError(
      expect.objectContaining({ code: 'BAD_REQUEST', statusCode: 400 }),
    );
    expect(() => resolveOrgActor({ actorUserId: '   ' })).toThrowError(
      expect.objectContaining({ code: 'BAD_REQUEST', statusCode: 400 }),
    );
  });

  it('does not treat an empty acting user as backend mode even with provenance', () => {
    // Ambiguity is decided before the value is inspected, so this is the
    // both-set error rather than the empty-value one. Either way it is never
    // backend mode.
    expect(() => resolveOrgActor({ actorUserId: '', actor: backendActor })).toThrowError(
      expect.objectContaining({ code: 'INTERNAL', statusCode: 500 }),
    );
  });
});

function request(overrides: Partial<FastifyRequest>): FastifyRequest {
  return overrides as unknown as FastifyRequest;
}

describe('orgCaller', () => {
  it('returns the acting user for a user-token request', () => {
    const req = request({ accessTokenClaims: { userId: 'user_1' } as never });

    expect(orgCaller(req)).toEqual({ actorUserId: 'user_1' });
  });

  it('returns backend provenance for a domain-pairing request', () => {
    const req = request({ orgBackendCaller: { domain: 'api.hugopos.eu' } });

    expect(orgCaller(req)).toEqual({ actor: backendActor });
  });

  // A user token, if present, always wins: `requireOrgRole` never sets
  // `orgBackendCaller` alongside claims, and if some future refactor did, the
  // narrower identity must be the one that is used.
  it('prefers the acting user when both are somehow present', () => {
    const req = request({
      accessTokenClaims: { userId: 'user_1' } as never,
      orgBackendCaller: { domain: 'api.hugopos.eu' },
    });

    expect(orgCaller(req)).toEqual({ actorUserId: 'user_1' });
  });

  // Without either, the request never passed `requireOrgRole` — refuse rather
  // than manufacture a backend caller out of nothing.
  it('raises 401 when the request carries neither', () => {
    expect(() => orgCaller(request({}))).toThrowError(
      expect.objectContaining({
        code: 'UNAUTHORIZED',
        statusCode: 401,
        message: 'MISSING_ACCESS_TOKEN',
      }),
    );
  });
});

describe('tenantUserId', () => {
  it('is the acting user on the user path', () => {
    expect(tenantUserId(request({ accessTokenClaims: { userId: 'user_1' } as never }))).toBe(
      'user_1',
    );
  });

  // `app.user_id` appears in the RLS policies only as an ADDITIVE owner-of /
  // member-of branch, so leaving it null narrows what the transaction can see.
  it('is null in backend mode rather than borrowing an identity', () => {
    expect(tenantUserId(request({ orgBackendCaller: { domain: 'api.hugopos.eu' } }))).toBeNull();
  });
});
