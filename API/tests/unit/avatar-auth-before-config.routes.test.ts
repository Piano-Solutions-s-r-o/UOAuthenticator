import { lookup } from 'node:dns/promises';
import { fetch as undiciFetch } from 'undici';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';
import { expectJsonError } from '../helpers/error-response.js';

/**
 * The avatar GETs accept an optional signed `config_url`, which `optionalConfigVerifier` fetches
 * and verifies. That is real outbound work aimed by the caller — DNS, an HTTPS fetch with its own
 * multi-second budget, JWKS lookup, signature verification. It must happen only once the caller has
 * proved it holds the domain-hash bearer, otherwise an anonymous request is an amplifier: the
 * attacker picks the target, UOA pays the DNS and TLS, and the 401 arrives afterwards.
 *
 * `tests/setup.ts` already replaces `undici.fetch` and `dns/promises.lookup` with spies, so
 * "no outbound work was attempted" is directly observable. No database is needed: a request with no
 * `Authorization` header is rejected by the bearer guard before it touches Prisma.
 */

const DOMAIN = 'client.example.com';
const ATTACKER_CONFIG_URL = 'https://config-target.example.com/config.jwt';

const originalDatabaseUrl = process.env.DATABASE_URL;

let app: Awaited<ReturnType<typeof createApp>>;

beforeAll(async () => {
  Reflect.deleteProperty(process.env, 'DATABASE_URL');
  app = await createApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  if (originalDatabaseUrl === undefined) {
    Reflect.deleteProperty(process.env, 'DATABASE_URL');
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }
});

afterEach(() => {
  vi.mocked(undiciFetch).mockClear();
  vi.mocked(lookup).mockClear();
});

function query(extra = ''): string {
  return (
    `domain=${encodeURIComponent(DOMAIN)}` +
    `&config_url=${encodeURIComponent(ATTACKER_CONFIG_URL)}${extra}`
  );
}

const routes: { name: string; url: string }[] = [
  { name: 'GET /avatar/me', url: `/avatar/me?${query()}` },
  { name: 'GET /domain/users/:userId/avatar', url: `/domain/users/usr_1/avatar?${query()}` },
  { name: 'GET /domain/teams/:teamId/avatar', url: `/domain/teams/tm_1/avatar?${query()}` },
];

describe('avatar GETs authenticate before doing any config work', () => {
  for (const route of routes) {
    it(`${route.name} answers 401 for an unauthenticated caller`, async () => {
      const response = await app.inject({ method: 'GET', url: route.url });

      expect(response.statusCode).toBe(401);
      expectJsonError(response.json());
    });

    it(`${route.name} attempts no outbound fetch for an unauthenticated config_url`, async () => {
      await app.inject({ method: 'GET', url: route.url });

      expect(vi.mocked(undiciFetch)).not.toHaveBeenCalled();
      expect(vi.mocked(lookup)).not.toHaveBeenCalled();
    });
  }

  it('rejects a bearer-less caller the same way with or without config_url', async () => {
    const withConfig = await app.inject({ method: 'GET', url: `/avatar/me?${query()}` });
    const withoutConfig = await app.inject({
      method: 'GET',
      url: `/avatar/me?domain=${encodeURIComponent(DOMAIN)}`,
    });

    // A differing status or code would turn the config hook into an oracle for anonymous callers.
    expect(withConfig.statusCode).toBe(401);
    expect(withoutConfig.statusCode).toBe(401);
    expect(withConfig.json()).toEqual(withoutConfig.json());
  });
});
