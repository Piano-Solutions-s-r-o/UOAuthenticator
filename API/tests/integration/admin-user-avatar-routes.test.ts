import { SignJWT } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import { ACCESS_TOKEN_AUDIENCE } from '../../src/config/constants.js';
import { createClientId } from '../../src/utils/hash.js';
import { cleanClientDomains } from '../helpers/domain-secret.js';
import { expectJsonError } from '../helpers/error-response.js';
import { createTestDb } from '../helpers/test-db.js';

/**
 * Operator-side user avatar management (Docs/Auth/avatars.md §5) — the user mirror of the admin
 * block in `team-avatar-routes.test.ts`. The GET half lives in `avatar-routes.test.ts`; this file
 * covers the PUT/DELETE mutations, their auth boundary, and the audit rows they write.
 */

const hasDatabase = Boolean(process.env.DATABASE_URL);

const SHARED_SECRET = 'test-shared-secret-with-enough-length';
const ADMIN_SECRET = 'test-admin-token-secret-with-enough-length';
const ISSUER = 'uoa-auth-service';
const DOMAIN = 'client.example.com';
const ADMIN_DOMAIN = 'admin.example.com';

function png(fill = 0x21, length = 64): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(length, fill),
  ]);
}

function multipartFile(file: Buffer, filename = 'avatar.png', contentType = 'image/png') {
  const boundary = '----uoa-admin-user-avatar-test-boundary';
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

describe.skipIf(!hasDatabase)('PUT/DELETE /internal/admin/users/:userId/avatar', () => {
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
    await handle.prisma.adminAuditLog.deleteMany();
    await handle.prisma.userAvatar.deleteMany();
    await handle.prisma.domainRole.deleteMany();
    await handle.prisma.user.deleteMany();
    await cleanClientDomains(handle.prisma);

    app = await createApp();
    await app.ready();
  });

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function seedUser(params: { email: string; domain?: string }): Promise<string> {
    const user = await handle!.prisma.user.create({
      data: {
        email: params.email,
        userKey: params.email,
        passwordHash: null,
        name: 'Test User',
        domain: params.domain ?? null,
        avatarUrl: null,
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

  async function seedAdminToken(): Promise<string> {
    const adminId = await seedUser({ email: 'avatar-admin@example.com' });
    await handle!.prisma.domainRole.create({
      data: { domain: ADMIN_DOMAIN, userId: adminId, role: 'SUPERUSER' },
    });
    return await signAccessToken({
      userId: adminId,
      email: 'avatar-admin@example.com',
      domain: ADMIN_DOMAIN,
      role: 'superuser',
      secret: ADMIN_SECRET,
    });
  }

  it('replaces and clears any user avatar, writing audit entries', async () => {
    const adminToken = await seedAdminToken();
    const userId = await seedUser({ email: 'target@example.com', domain: DOMAIN });
    const url = `/internal/admin/users/${userId}/avatar`;
    const headers = { authorization: `Bearer ${adminToken}` };

    const generated = await app!.inject({ method: 'GET', url, headers });
    expect(generated.statusCode).toBe(200);
    expect(generated.headers['x-uoa-avatar-source']).toBe('generated');

    const bytes = png(0x77);
    const upload = multipartFile(bytes);
    const put = await app!.inject({
      method: 'PUT',
      url,
      headers: { ...headers, 'content-type': upload.contentType },
      payload: upload.body,
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({
      ok: true,
      avatar: { source: 'uploaded', content_type: 'image/png', size_bytes: bytes.byteLength },
    });

    const uploaded = await app!.inject({ method: 'GET', url, headers });
    expect(uploaded.statusCode).toBe(200);
    expect(uploaded.headers['x-uoa-avatar-source']).toBe('uploaded');
    expect(uploaded.headers['content-type']).toBe('image/png');
    expect(uploaded.rawPayload.equals(bytes)).toBe(true);

    // Idempotent: the second DELETE still succeeds against an already-empty row set.
    for (const expected of [200, 200]) {
      const del = await app!.inject({ method: 'DELETE', url, headers });
      expect(del.statusCode).toBe(expected);
      expect(del.json()).toEqual({ ok: true });
    }
    expect(await handle!.prisma.userAvatar.count()).toBe(0);

    const afterDelete = await app!.inject({ method: 'GET', url, headers });
    expect(afterDelete.headers['x-uoa-avatar-source']).toBe('generated');

    const audit = await handle!.prisma.adminAuditLog.findMany({
      where: { action: { in: ['user.avatar_updated', 'user.avatar_deleted'] } },
      select: { action: true, targetDomain: true, actorEmail: true },
      orderBy: { createdAt: 'asc' },
    });
    expect(audit.map((row) => row.action)).toEqual([
      'user.avatar_updated',
      'user.avatar_deleted',
      'user.avatar_deleted',
    ]);
    expect(new Set(audit.map((row) => row.targetDomain))).toEqual(new Set([DOMAIN]));
    expect(new Set(audit.map((row) => row.actorEmail))).toEqual(
      new Set(['avatar-admin@example.com']),
    );
  });

  it('rejects an SVG upload with a generic error and writes no audit row', async () => {
    const adminToken = await seedAdminToken();
    const userId = await seedUser({ email: 'svg-target@example.com', domain: DOMAIN });
    const upload = multipartFile(
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      'avatar.svg',
      // Lie about the type: the sniffed verdict is what counts.
      'image/png',
    );

    const res = await app!.inject({
      method: 'PUT',
      url: `/internal/admin/users/${userId}/avatar`,
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': upload.contentType },
      payload: upload.body,
    });

    expect(res.statusCode).toBe(400);
    expectJsonError(res.json());
    expect(await handle!.prisma.userAvatar.count()).toBe(0);
    expect(await handle!.prisma.adminAuditLog.count()).toBe(0);
  });

  it('refuses an upload over the 1 MiB cap', async () => {
    const adminToken = await seedAdminToken();
    const userId = await seedUser({ email: 'oversize-target@example.com', domain: DOMAIN });
    const upload = multipartFile(png(0x33, 2 * 1024 * 1024));

    const res = await app!.inject({
      method: 'PUT',
      url: `/internal/admin/users/${userId}/avatar`,
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': upload.contentType },
      payload: upload.body,
    });

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expectJsonError(res.json());
    expect(await handle!.prisma.userAvatar.count()).toBe(0);
  });

  it('returns 401 without a bearer, 403 for a non-superuser, and 404 for an unknown user', async () => {
    const adminToken = await seedAdminToken();
    const userId = await seedUser({ email: 'guarded@example.com', domain: DOMAIN });
    const upload = multipartFile(png(0x55));

    const anonymous = await app!.inject({
      method: 'PUT',
      url: `/internal/admin/users/${userId}/avatar`,
      headers: { 'content-type': upload.contentType },
      payload: upload.body,
    });
    expect(anonymous.statusCode).toBe(401);
    expectJsonError(anonymous.json());

    const plainToken = await signAccessToken({
      userId,
      email: 'guarded@example.com',
      domain: ADMIN_DOMAIN,
      role: 'user',
      secret: ADMIN_SECRET,
    });
    const forbidden = await app!.inject({
      method: 'DELETE',
      url: `/internal/admin/users/${userId}/avatar`,
      headers: { authorization: `Bearer ${plainToken}` },
    });
    expect(forbidden.statusCode).toBe(403);
    expectJsonError(forbidden.json());

    for (const method of ['PUT', 'DELETE'] as const) {
      const unknown = await app!.inject({
        method,
        url: '/internal/admin/users/usr_does_not_exist/avatar',
        headers:
          method === 'PUT'
            ? { authorization: `Bearer ${adminToken}`, 'content-type': upload.contentType }
            : { authorization: `Bearer ${adminToken}` },
        ...(method === 'PUT' ? { payload: upload.body } : {}),
      });
      expect(unknown.statusCode).toBe(404);
      expectJsonError(unknown.json());
    }

    expect(await handle!.prisma.userAvatar.count()).toBe(0);
    expect(await handle!.prisma.adminAuditLog.count()).toBe(0);
  });
});
