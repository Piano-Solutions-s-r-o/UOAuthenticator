import type { FastifyInstance } from 'fastify';

import { asPrismaClient } from '../../db/tenant-context.js';
import { configVerifier } from '../../middleware/config-verifier.js';
import requireDomainHashAuthForDomainQuery from '../../middleware/domain-hash-auth.js';
import { setTenantContextFromRequest } from '../../plugins/tenant-context.plugin.js';
import {
  createOrganisation,
  deleteOrganisation,
  getOrganisation,
  listOrganisationsForDomain,
  updateOrganisation,
} from '../../services/organisation.service.organisation.js';
import { createRateLimiter } from '../../middleware/rate-limiter.js';
import { requireOrgFeatures } from '../../middleware/org-features.js';
import { requireOrgRole } from '../../middleware/org-role-guard.js';
import { AppError } from '../../utils/errors.js';
import {
  CreateOrgBodySchema,
  OrgBodySchema,
  type RequestWithClaims,
  getOrgIdFromParams,
  keyCreateOrganisationRateLimit,
  orgCaller,
  parseDomainContext,
  parseDomainContextHook,
  parseLimitCursor,
  tenantUserId,
} from './organisation-route.shared.js';

export function registerOrganisationRoutes(app: FastifyInstance) {
  // VM2: this list endpoint is intentionally backend-to-backend. The domain hash
  // bearer token is the authorization boundary; user-scoped reads use /org/me.
  app.get(
    '/org/organisations',
    {
      preValidation: [
        requireDomainHashAuthForDomainQuery(),
        configVerifier,
        parseDomainContextHook,
        requireOrgFeatures,
      ],
    },
    async (request, reply) => {
      const { domain, limit, cursor } = parseLimitCursor(request);
      // /org/organisations list uses organisations bootstrap predicate
      // (domain + membership); app.org_id left empty intentionally.
      setTenantContextFromRequest(request, { orgId: null });
      const page = await request.withTenantTx((tx) =>
        listOrganisationsForDomain(
          { domain, limit, cursor },
          { prisma: asPrismaClient(tx) },
        ),
      );

      reply.status(200).send(page);
    },
  );

  app.post(
    '/org/organisations',
    {
      preValidation: [
        requireDomainHashAuthForDomainQuery(),
        configVerifier,
        parseDomainContextHook,
        requireOrgFeatures,
        requireOrgRole(),
        createRateLimiter({
          limit: 5,
          windowMs: 60 * 60 * 1000,
          keyBuilder: keyCreateOrganisationRateLimit,
        }),
      ],
    },
    async (request, reply) => {
      const { domain } = parseDomainContext(request);
      const { name, owner_user_id: ownerUserId } = CreateOrgBodySchema.parse(request.body ?? {});
      const caller = orgCaller(request);
      const config = request.config;
      if (!config) throw new AppError('UNAUTHORIZED', 401, 'MISSING_CONFIG');

      // The owner is the acting user on the user path, and an explicit body field
      // in backend mode. Exactly one of the two — a user-token call that also
      // names an owner is ambiguous about who should own the org, and a backend
      // call that names nobody has no owner to give it.
      let ownerId: string;
      if ('actorUserId' in caller) {
        if (ownerUserId) throw new AppError('BAD_REQUEST', 400, 'OWNER_NOT_ALLOWED');

        // `allow_user_create_org` governs whether END USERS may create orgs. It
        // has no bearing on the backend path, where the domain itself is asking.
        const claims = (request as RequestWithClaims).accessTokenClaims;
        const isSuperuser = claims?.role === 'superuser';
        if (!isSuperuser && !config.org_features?.allow_user_create_org) {
          throw new AppError('FORBIDDEN', 403, 'ORG_CREATION_NOT_ALLOWED');
        }
        ownerId = caller.actorUserId;
      } else {
        if (!ownerUserId) throw new AppError('BAD_REQUEST', 400, 'OWNER_REQUIRED');
        ownerId = ownerUserId;
      }

      // Create uses the organisations bootstrap branch (domain + owner_id matches
      // app.user_id); app.org_id is not yet known. The owner is the subject of the
      // INSERT policy either way, so it is `app.user_id` on both paths.
      setTenantContextFromRequest(request, { orgId: null, userId: ownerId });
      const org = await request.withTenantTx((tx) =>
        createOrganisation(
          { domain, name, ownerId, config },
          { prisma: asPrismaClient(tx) },
        ),
      );

      reply.status(200).send(org);
    },
  );

  app.get(
    '/org/organisations/:orgId',
    {
      preValidation: [
        requireDomainHashAuthForDomainQuery(),
        configVerifier,
        parseDomainContextHook,
        requireOrgFeatures,
        requireOrgRole(),
      ],
    },
    async (request, reply) => {
      const { domain } = parseDomainContext(request);
      const orgId = getOrgIdFromParams(request.params);

      setTenantContextFromRequest(request, { orgId, userId: tenantUserId(request) });
      const org = await request.withTenantTx((tx) =>
        getOrganisation({ orgId, domain, ...orgCaller(request) }, { prisma: asPrismaClient(tx) }),
      );

      reply.status(200).send(org);
    },
  );

  app.put(
    '/org/organisations/:orgId',
    {
      preValidation: [
        requireDomainHashAuthForDomainQuery(),
        configVerifier,
        parseDomainContextHook,
        requireOrgFeatures,
        requireOrgRole(),
      ],
    },
    async (request, reply) => {
      const { domain } = parseDomainContext(request);
      const config = request.config;
      if (!config) throw new AppError('UNAUTHORIZED', 401, 'MISSING_CONFIG');

      const orgId = getOrgIdFromParams(request.params);
      const { name, member_invites, icon_url } = OrgBodySchema.parse(request.body ?? {});

      setTenantContextFromRequest(request, { orgId, userId: tenantUserId(request) });
      const org = await request.withTenantTx((tx) =>
        updateOrganisation(
          {
            orgId,
            domain,
            name,
            ...orgCaller(request),
            config,
            memberInvites: member_invites,
            iconUrl: icon_url,
          },
          { prisma: asPrismaClient(tx) },
        ),
      );

      reply.status(200).send(org);
    },
  );

  app.delete(
    '/org/organisations/:orgId',
    {
      preValidation: [
        requireDomainHashAuthForDomainQuery(),
        configVerifier,
        parseDomainContextHook,
        requireOrgFeatures,
        requireOrgRole(),
      ],
    },
    async (request, reply) => {
      const { domain } = parseDomainContext(request);
      const orgId = getOrgIdFromParams(request.params);

      setTenantContextFromRequest(request, { orgId, userId: tenantUserId(request) });
      await request.withTenantTx((tx) =>
        deleteOrganisation(
          { orgId, domain, ...orgCaller(request) },
          { prisma: asPrismaClient(tx) },
        ),
      );

      reply.status(200).send({ ok: true });
    },
  );
}
