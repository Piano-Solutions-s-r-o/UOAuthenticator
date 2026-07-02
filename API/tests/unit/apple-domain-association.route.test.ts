import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('GET /.well-known/apple-developer-domain-association.txt', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
    delete process.env.DATABASE_URL;
    delete process.env.APPLE_DOMAIN_ASSOCIATION;
  });

  afterEach(() => {
    delete process.env.APPLE_DOMAIN_ASSOCIATION;
  });

  it('returns 404 when APPLE_DOMAIN_ASSOCIATION is unset', async () => {
    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/.well-known/apple-developer-domain-association.txt',
    });

    expect(res.statusCode).toBe(404);

    await app.close();
  });

  it('serves APPLE_DOMAIN_ASSOCIATION as text/plain when configured', async () => {
    process.env.APPLE_DOMAIN_ASSOCIATION = 'apple-domain-association-content';

    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/.well-known/apple-developer-domain-association.txt',
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toBe('apple-domain-association-content');

    await app.close();
  });
});
