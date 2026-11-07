import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';

import { registrationLinkRateLimiter } from '../../src/routes/auth/rate-limit-keys.js';

const request = (ip: string, token: string) => ({ ip, body: { token } }) as unknown as FastifyRequest;
const send = async (count: number, build: (index: number) => FastifyRequest) => {
  let accepted = 0;
  for (let index = 0; index < count; index += 1) {
    await registrationLinkRateLimiter(build(index)).then(() => { accepted += 1; }, () => undefined);
  }
  return accepted;
};

describe('registration link rate limit', () => {
  it('holds one link to a tight budget, wherever it comes from', async () => {
    const token = 'one-link-'.padEnd(43, 'a');
    expect(await send(12, index => request(`198.18.0.${index + 1}`, token))).toBe(10);
  });

  it('lets a carrier address open many different links, up to a wide ceiling', async () => {
    expect(await send(62, index => request('198.18.1.1', `token-${index}-`.padEnd(43, 'b')))).toBe(60);
  });
});
