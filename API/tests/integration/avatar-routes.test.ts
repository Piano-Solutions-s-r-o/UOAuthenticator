import { SignJWT } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import { ACCESS_TOKEN_AUDIENCE } from '../../src/config/constants.js';
import { digestDomainClientHash } from '../../src/utils/client-hash.js';
import { createClientId } from '../../src/utils/hash.js';
import { expectJsonError } from '../helpers/error-response.js';
import { createTestDb } from '../helpers/test-db.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);

const SHARED_SECRET = 'test-shared-secret-with-enough-length';
const ADMIN_SECRET = 'test-admin-token-secret-with-enough-length';
const ISSUER = 'uoa-auth-service';
const DOMAIN = 'client.example.com';
const OTHER_DOMAIN = 'other.example.com';
const ADMIN_DOMAIN = 'admin.example.com';

function png(fill = 0x21, length = 64): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(length, fill),
  ]);
}

function multipartFile(file: Buffer, filename = 'avatar.png', contentType = 'image/png') {
  const boundary = '----uoa-avatar-test-boundary';
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`,
    ),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

async function signAccessToken(params: {
  userId: string;
  email: string;
  domain: string;
  secret?: string;
  role?: 'superuser' | 'user';
}): Promise<string> {
  return await new SignJWT({
    email: params.email,
    domain: params.domain,
    client_id: createClientId(params.domain, SHARED_SECRET),
    role: params.role ?? 'user',
    tv: 0,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(params.userId)
    .setIssuer(ISSUER)
    .setAudience(ACCESS_TOKEN_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('30m')
    .sign(new TextEncoder().encode(params.secret ?? SHARED_SECRET));
}

describe.skipIf(!hasDatabase)('avatar routes', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;
  let app: Awaited<ReturnType<typeof createApp>> | null = null;

  const original = {
    DATABASE_URL: process.env.DATABASE_URL,
    SHARED_SECRET: process.env.SHARED_SECRET,
    AUTH_SERVICE_IDENTIFIER: process.env.AUTH_SERVICE_IDENTIFIER,
    ADMIN_AUTH_DOMAIN: process.env.ADMIN_AUTH_DOMAIN,
    ADMIN_ACCESS_TOKEN_SECRET: process.env.ADMIN_ACCESS_TOKEN_SECRET,
  };

  beforeAll(async () => {
    handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for DB-backed tests');
    process.env.DATABASE_URL = handle.databaseUrl;
    process.env.SHARED_SECRET = SHARED_SECRET;
    process.env.AUTH_SERVICE_IDENTIFIER = ISSUER;
    process.env.ADMIN_AUTH_DOMAIN = ADMIN_DOMAIN;
    process.env.ADMIN_ACCESS_TOKEN_SECRET = ADMIN_SECRET;
  });

  afterAll(async () => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    if (handle) await handle.cleanup();
  });

  beforeEach(async () => {
    if (!handle) return;
    await handle.prisma.userAvatar.deleteMany();
    await handle.prisma.domainRole.deleteMany();
    await handle.prisma.user.deleteMany();
    await handle.prisma.clientDomainSecret.deleteMany();
    await handle.prisma.clientDomain.deleteMany();

    app = await createApp();
    await app.ready();
  });

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function seedDomainSecret(domain: string): Promise<string> {
    const clientHash = createClientId(domain, SHARED_SECRET);
    await handle!.prisma.clientDomain.create({
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

  async function seedUser(params: {
    email: string;
    domain?: string;
    avatarUrl?: string | null;
  }): Promise<string> {
    const user = await handle!.prisma.user.create({
      data: {
        email: params.email,
        userKey: params.email,
        passwordHash: null,
        name: 'Test User',
        avatarUrl: params.avatarUrl ?? null,
      },
      select: { id: true },
    });

    if (params.domain) {
      await handle!.prisma.domainRole.create({
        data: { domain: params.domain, userId: user.id, role: 'USER' },
      });
    }

    return user.id;
  }

  describe('GET/PUT/DELETE /domain/users/:userId/avatar', () => {
    it('round-trips an upload and falls back to the generated image after delete', async () => {
      const hash = await seedDomainSecret(DOMAIN);
      const userId = await seedUser({ email: 'roundtrip@example.com', domain: DOMAIN });
      const url = `/domain/users/${userId}/avatar?domain=${encodeURIComponent(DOMAIN)}`;

      // No upload and no provider URL: the deterministic SVG.
      const generated = await app!.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${hash}` },
      });
      expect(generated.statusCode).toBe(200);
      expect(generated.headers['x-uoa-avatar-source']).toBe('generated');
      expect(generated.headers['content-type']).toBe('image/svg+xml; charset=utf-8');
      expect(generated.headers['cache-control']).toBe('private, max-age=86400');
      expect(generated.headers['x-content-type-options']).toBe('nosniff');
      expect(generated.headers['content-disposition']).toBe('inline; filename="avatar.svg"');
      expect(generated.headers['content-security-policy']).toBe(
        "default-src 'none'; style-src 'unsafe-inline'",
      );
      expect(generated.body).toContain('<svg');

      // A matching ETag short-circuits.
      const notModified = await app!.inject({
        method: 'GET',
        url,
        headers: {
          authorization: `Bearer ${hash}`,
          'if-none-match': String(generated.headers.etag),
        },
      });
      expect(notModified.statusCode).toBe(304);

      // Upload.
      const bytes = png();
      const upload = multipartFile(bytes);
      const put = await app!.inject({
        method: 'PUT',
        url,
        headers: { authorization: `Bearer ${hash}`, 'content-type': upload.contentType },
        payload: upload.body,
      });
      expect(put.statusCode).toBe(200);
      expect(put.json()).toMatchObject({
        ok: true,
        avatar: { source: 'uploaded', content_type: 'image/png', size_bytes: bytes.byteLength },
      });

      const uploaded = await app!.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${hash}` },
      });
      expect(uploaded.statusCode).toBe(200);
      expect(uploaded.headers['x-uoa-avatar-source']).toBe('uploaded');
      expect(uploaded.headers['content-type']).toBe('image/png');
      expect(uploaded.headers['cache-control']).toBe('private, max-age=300');
      // Raster responses keep the app-wide helmet CSP; only SVG gets the restrictive one.
      expect(uploaded.headers['content-security-policy']).not.toBe(
        "default-src 'none'; style-src 'unsafe-inline'",
      );
      expect(uploaded.headers['content-disposition']).toBe('inline; filename="avatar.png"');
      expect(uploaded.rawPayload.equals(bytes)).toBe(true);

      // GET /domain/users now reports the source additively.
      const list = await app!.inject({
        method: 'GET',
        url: `/domain/users?domain=${encodeURIComponent(DOMAIN)}`,
        headers: { authorization: `Bearer ${hash}` },
      });
      expect(list.statusCode).toBe(200);
      expect((list.json() as { users: Array<{ avatar_source: string }> }).users[0].avatar_source).toBe(
        'uploaded',
      );

      // Delete is idempotent and resolution drops back to generated.
      for (const expected of [200, 200]) {
        const del = await app!.inject({
          method: 'DELETE',
          url,
          headers: { authorization: `Bearer ${hash}` },
        });
        expect(del.statusCode).toBe(expected);
        expect(del.json()).toEqual({ ok: true });
      }

      const afterDelete = await app!.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${hash}` },
      });
      expect(afterDelete.headers['x-uoa-avatar-source']).toBe('generated');
    });

    it('honours ?style= and ?size= on the generated image', async () => {
      const hash = await seedDomainSecret(DOMAIN);
      const userId = await seedUser({ email: 'styled@example.com', domain: DOMAIN });

      const mono = await app!.inject({
        method: 'GET',
        url: `/domain/users/${userId}/avatar?domain=${encodeURIComponent(DOMAIN)}&style=mono&size=64`,
        headers: { authorization: `Bearer ${hash}` },
      });

      expect(mono.statusCode).toBe(200);
      expect(mono.body).toContain('width="64" height="64"');
      expect(mono.body).toContain('viewBox="0 0 100 100"');
      expect(mono.body).not.toContain('hsl(');
    });

    it('rejects an SVG upload with a generic error', async () => {
      const hash = await seedDomainSecret(DOMAIN);
      const userId = await seedUser({ email: 'svg@example.com', domain: DOMAIN });
      const upload = multipartFile(
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
        'avatar.svg',
        // Lie about the type: the sniffed verdict is what counts.
        'image/png',
      );

      const res = await app!.inject({
        method: 'PUT',
        url: `/domain/users/${userId}/avatar?domain=${encodeURIComponent(DOMAIN)}`,
        headers: { authorization: `Bearer ${hash}`, 'content-type': upload.contentType },
        payload: upload.body,
      });

      expect(res.statusCode).toBe(400);
      expectJsonError(res.json());
      expect(await handle!.prisma.userAvatar.count()).toBe(0);
    });

    it('refuses an upload over the 1 MiB cap', async () => {
      const hash = await seedDomainSecret(DOMAIN);
      const userId = await seedUser({ email: 'oversize@example.com', domain: DOMAIN });
      const upload = multipartFile(png(0x33, 2 * 1024 * 1024));

      const res = await app!.inject({
        method: 'PUT',
        url: `/domain/users/${userId}/avatar?domain=${encodeURIComponent(DOMAIN)}`,
        headers: { authorization: `Bearer ${hash}`, 'content-type': upload.contentType },
        payload: upload.body,
      });

      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expectJsonError(res.json());
      expect(await handle!.prisma.userAvatar.count()).toBe(0);
    });

    it('returns 401 for a bad domain hash', async () => {
      await seedDomainSecret(DOMAIN);
      const userId = await seedUser({ email: 'unauth@example.com', domain: DOMAIN });

      const res = await app!.inject({
        method: 'GET',
        url: `/domain/users/${userId}/avatar?domain=${encodeURIComponent(DOMAIN)}`,
        headers: { authorization: 'Bearer invalid' },
      });

      expect(res.statusCode).toBe(401);
      expectJsonError(res.json());
    });

    it('returns a generic 404 for unknown and cross-domain user ids', async () => {
      const hash = await seedDomainSecret(DOMAIN);
      await seedDomainSecret(OTHER_DOMAIN);
      const foreignUserId = await seedUser({ email: 'foreign@example.com', domain: OTHER_DOMAIN });

      for (const userId of ['usr_does_not_exist', foreignUserId]) {
        const res = await app!.inject({
          method: 'GET',
          url: `/domain/users/${userId}/avatar?domain=${encodeURIComponent(DOMAIN)}`,
          headers: { authorization: `Bearer ${hash}` },
        });
        expect(res.statusCode).toBe(404);
        expectJsonError(res.json());
      }
    });
  });

  describe('GET/PUT/DELETE /avatar/me', () => {
    it('serves and updates the access-token subject only', async () => {
      const hash = await seedDomainSecret(DOMAIN);
      const userId = await seedUser({ email: 'me@example.com', domain: DOMAIN });
      const token = await signAccessToken({ userId, email: 'me@example.com', domain: DOMAIN });
      const url = `/avatar/me?domain=${encodeURIComponent(DOMAIN)}`;
      const headers = {
        authorization: `Bearer ${hash}`,
        'x-uoa-access-token': `Bearer ${token}`,
      };

      const generated = await app!.inject({ method: 'GET', url, headers });
      expect(generated.statusCode).toBe(200);
      expect(generated.headers['x-uoa-avatar-source']).toBe('generated');

      const upload = multipartFile(png(0x44));
      const put = await app!.inject({
        method: 'PUT',
        url,
        headers: { ...headers, 'content-type': upload.contentType },
        payload: upload.body,
      });
      expect(put.statusCode).toBe(200);
      expect(put.json()).toMatchObject({ ok: true, avatar: { source: 'uploaded' } });

      // The row belongs to the token subject, not to anyone named in the request.
      const stored = await handle!.prisma.userAvatar.findMany({ select: { userId: true } });
      expect(stored).toEqual([{ userId }]);

      const del = await app!.inject({ method: 'DELETE', url, headers });
      expect(del.statusCode).toBe(200);
      expect(await handle!.prisma.userAvatar.count()).toBe(0);
    });

    it('returns 401 without an access token, and 401 with only an access token', async () => {
      const hash = await seedDomainSecret(DOMAIN);
      const userId = await seedUser({ email: 'partial@example.com', domain: DOMAIN });
      const token = await signAccessToken({ userId, email: 'partial@example.com', domain: DOMAIN });
      const url = `/avatar/me?domain=${encodeURIComponent(DOMAIN)}`;

      const noToken = await app!.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${hash}` },
      });
      expect(noToken.statusCode).toBe(401);
      expectJsonError(noToken.json());

      const noHash = await app!.inject({
        method: 'GET',
        url,
        headers: { 'x-uoa-access-token': `Bearer ${token}` },
      });
      expect(noHash.statusCode).toBe(401);
      expectJsonError(noHash.json());
    });

    it('rejects an access token minted for a different domain', async () => {
      const hash = await seedDomainSecret(DOMAIN);
      await seedDomainSecret(OTHER_DOMAIN);
      const userId = await seedUser({ email: 'mismatch@example.com', domain: OTHER_DOMAIN });
      const token = await signAccessToken({
        userId,
        email: 'mismatch@example.com',
        domain: OTHER_DOMAIN,
      });

      const res = await app!.inject({
        method: 'GET',
        url: `/avatar/me?domain=${encodeURIComponent(DOMAIN)}`,
        headers: {
          authorization: `Bearer ${hash}`,
          'x-uoa-access-token': `Bearer ${token}`,
        },
      });

      expect(res.statusCode).toBe(403);
      expectJsonError(res.json());
    });
  });

  describe('GET /internal/admin/users/:userId/avatar', () => {
    async function seedAdmin(): Promise<string> {
      const adminId = await seedUser({ email: 'admin@example.com' });
      await handle!.prisma.domainRole.create({
        data: { domain: ADMIN_DOMAIN, userId: adminId, role: 'SUPERUSER' },
      });
      return await signAccessToken({
        userId: adminId,
        email: 'admin@example.com',
        domain: ADMIN_DOMAIN,
        role: 'superuser',
        secret: ADMIN_SECRET,
      });
    }

    it('returns image bytes for any user with an admin superuser bearer', async () => {
      const adminToken = await seedAdmin();
      const userId = await seedUser({ email: 'target@example.com', domain: DOMAIN });

      const res = await app!.inject({
        method: 'GET',
        url: `/internal/admin/users/${userId}/avatar`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['x-uoa-avatar-source']).toBe('generated');
      expect(res.headers['content-type']).toBe('image/svg+xml; charset=utf-8');
      expect(res.body).toContain('<svg');
    });

    it('returns 401 without a bearer and 403 for a non-superuser token', async () => {
      const userId = await seedUser({ email: 'target2@example.com', domain: DOMAIN });

      const anonymous = await app!.inject({
        method: 'GET',
        url: `/internal/admin/users/${userId}/avatar`,
      });
      expect(anonymous.statusCode).toBe(401);
      expectJsonError(anonymous.json());

      const plainUserToken = await signAccessToken({
        userId,
        email: 'target2@example.com',
        domain: ADMIN_DOMAIN,
        role: 'user',
        secret: ADMIN_SECRET,
      });
      const forbidden = await app!.inject({
        method: 'GET',
        url: `/internal/admin/users/${userId}/avatar`,
        headers: { authorization: `Bearer ${plainUserToken}` },
      });
      expect(forbidden.statusCode).toBe(403);
      expectJsonError(forbidden.json());
    });
  });
});
