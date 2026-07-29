import type { PrismaClient } from '@prisma/client';

import { digestDomainClientHash } from '../../src/utils/client-hash.js';
import { createClientId } from '../../src/utils/hash.js';

/**
 * Seed an active ClientDomain row with an active secret whose digest matches
 * `createClientId(domain, clientSecret)`. Domain-hash bearer auth
 * (`verifyDomainAuthToken`) only accepts tokens that resolve to an active
 * `client_domains` row with a matching active secret digest, so every
 * DB-backed test that authenticates with a domain-hash bearer must seed this
 * first. Returns the client hash to use as the bearer token.
 */
export async function seedDomainSecret(
  prisma: PrismaClient,
  domain: string,
  clientSecret: string = process.env.SHARED_SECRET!,
): Promise<string> {
  const clientHash = createClientId(domain, clientSecret);
  await prisma.clientDomain.create({
    data: {
      domain,
      label: domain,
      status: 'active',
      secrets: {
        create: {
          active: true,
          hashPrefix: clientHash.slice(0, 12),
          secretDigest: digestDomainClientHash(clientHash),
        },
      },
    },
  });
  return clientHash;
}

/**
 * Delete all ClientDomain rows (secrets first, to satisfy the FK). Call from
 * `beforeEach` alongside the other table cleanups in files that seed domains.
 */
export async function cleanClientDomains(prisma: PrismaClient): Promise<void> {
  await prisma.clientDomainSecret.deleteMany();
  await prisma.clientDomain.deleteMany();
}
