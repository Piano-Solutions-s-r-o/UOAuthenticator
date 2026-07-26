import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';

const originalDatabaseUrl = process.env.DATABASE_URL;

beforeAll(() => {
  Reflect.deleteProperty(process.env, 'DATABASE_URL');
});

afterAll(() => {
  if (originalDatabaseUrl === undefined) {
    Reflect.deleteProperty(process.env, 'DATABASE_URL');
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }
});

async function appCsp(): Promise<string> {
  const app = await createApp();
  await app.ready();
  try {
    const response = await app.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(200);
    return String(response.headers['content-security-policy']);
  } finally {
    await app.close();
  }
}

function directive(csp: string, name: string): string {
  const found = csp
    .split(';')
    .map((part) => part.trim())
    .find((part) => part === name || part.startsWith(`${name} `));

  return found ?? '';
}

describe('app-wide security headers', () => {
  it('allows blob: images so the admin SPA can render bearer-fetched avatars', async () => {
    // The admin avatar endpoints require the admin bearer, which <img src> cannot send,
    // so the SPA renders avatars from URL.createObjectURL blobs. Without blob: in
    // img-src every admin avatar is CSP-blocked and silently falls back to initials.
    const imgSrc = directive(await appCsp(), 'img-src');

    expect(imgSrc).toContain('blob:');
    expect(imgSrc).toContain("'self'");
  });

  it('keeps blob: scoped to img-src and does not widen script or default sources', async () => {
    const csp = await appCsp();

    expect(directive(csp, 'default-src')).toBe("default-src 'self'");
    expect(directive(csp, 'script-src')).not.toContain('blob:');
    expect(directive(csp, 'connect-src')).not.toContain('blob:');
    expect(directive(csp, 'object-src')).toBe("object-src 'none'");
  });
});
