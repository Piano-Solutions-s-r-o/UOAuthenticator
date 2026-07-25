import { createHash } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import {
  AVATAR_DYNAMIC_CACHE_CONTROL,
  AVATAR_GENERATED_CACHE_CONTROL,
  AVATAR_MAX_BYTES,
} from '../config/constants.js';
import { getEnv } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import {
  clampAvatarSize,
  generateAvatarSvg,
  resolveAvatarStyle,
  type AvatarStyle,
} from '../utils/avatar-svg.js';
import { normalizeDomain } from '../utils/domain.js';
import { AppError } from '../utils/errors.js';
import { rasterImageExtension, sniffRasterImageType } from '../utils/image-sniff.js';
import { fetchProviderAvatar, type ProviderAvatarImage } from './avatar-provider.service.js';

export type AvatarSource = 'uploaded' | 'provider' | 'generated';

export type ResolvedAvatar = {
  source: AvatarSource;
  contentType: string;
  body: Buffer;
  etag: string;
  cacheControl: string;
  filename: string;
  isSvg: boolean;
};

export type AvatarUploadResult = {
  source: 'uploaded';
  contentType: string;
  sizeBytes: number;
  updatedAt: Date;
};

type AvatarPrisma = {
  user: Pick<PrismaClient['user'], 'findUnique' | 'findMany'>;
  userAvatar: Pick<
    PrismaClient['userAvatar'],
    'findUnique' | 'findMany' | 'upsert' | 'deleteMany'
  >;
  domainRole: Pick<PrismaClient['domainRole'], 'findUnique'>;
};

export type AvatarDeps = {
  prisma?: AvatarPrisma;
  fetchProvider?: (avatarUrl: string | null | undefined) => Promise<ProviderAvatarImage | null>;
};

function prismaFor(deps?: AvatarDeps): AvatarPrisma {
  if (deps?.prisma) return deps.prisma;
  if (!getEnv().DATABASE_URL) throw new AppError('NOT_FOUND', 404, 'AVATAR_DB_DISABLED');
  return getAdminPrisma() as unknown as AvatarPrisma;
}

function etagFor(body: Buffer): string {
  return `"sha256-${createHash('sha256').update(body).digest('hex')}"`;
}

// Prisma's `Bytes` column typing requires `Uint8Array<ArrayBuffer>`; Node `Buffer` is structurally
// compatible but TS sees `Buffer<ArrayBufferLike>`. Copy at the persistence boundary, same as
// `integration-claim.service.ts`.
function toBytes(buf: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(buf.byteLength));
  out.set(buf);
  return out;
}

/**
 * Resolve a `:userId` under the same visibility rules as `GET /domain/users`: the user must hold a
 * DomainRole on the authenticated domain. Anything else — unknown id, or a user that exists but
 * belongs to another domain — is the standard generic 404, so these routes add no enumeration
 * signal beyond what the same credentials already get from the user list.
 */
export async function requireDomainUserId(
  params: { domain: string; userId: string },
  deps?: AvatarDeps,
): Promise<string> {
  const domain = normalizeDomain(params.domain);
  if (!domain) throw new AppError('BAD_REQUEST', 400, 'MISSING_DOMAIN');

  const prisma = prismaFor(deps);
  const role = await prisma.domainRole.findUnique({
    where: { domain_userId: { domain, userId: params.userId } },
    select: { userId: true },
  });
  if (!role) throw new AppError('NOT_FOUND', 404, 'USER_NOT_FOUND');

  return role.userId;
}

/**
 * Fixed precedence (Docs/Auth/avatars.md §1): uploaded → proxied provider → generated.
 * Always returns an image for a known user; unknown users are a generic 404.
 */
export async function resolveAvatar(
  params: {
    userId: string;
    style?: AvatarStyle | null;
    configDefaultStyle?: AvatarStyle | null;
    size?: number | null;
  },
  deps?: AvatarDeps,
): Promise<ResolvedAvatar> {
  const prisma = prismaFor(deps);

  const [uploaded, user] = await Promise.all([
    prisma.userAvatar.findUnique({
      where: { userId: params.userId },
      select: { contentType: true, data: true },
    }),
    prisma.user.findUnique({
      where: { id: params.userId },
      select: { id: true, avatarUrl: true },
    }),
  ]);

  if (!user) throw new AppError('NOT_FOUND', 404, 'USER_NOT_FOUND');

  if (uploaded) {
    const body = Buffer.from(uploaded.data);
    return {
      source: 'uploaded',
      contentType: uploaded.contentType,
      body,
      etag: etagFor(body),
      cacheControl: AVATAR_DYNAMIC_CACHE_CONTROL,
      filename: `avatar.${rasterImageExtension(uploaded.contentType)}`,
      isSvg: false,
    };
  }

  if (user.avatarUrl) {
    const fetchProvider = deps?.fetchProvider ?? fetchProviderAvatar;
    // Never throws — a failed provider fetch is indistinguishable from "no provider image".
    const proxied = await fetchProvider(user.avatarUrl);
    if (proxied) {
      return {
        source: 'provider',
        contentType: proxied.contentType,
        body: proxied.body,
        etag: etagFor(proxied.body),
        cacheControl: AVATAR_DYNAMIC_CACHE_CONTROL,
        filename: `avatar.${rasterImageExtension(proxied.contentType)}`,
        isSvg: false,
      };
    }
  }

  return generatedAvatar(params);
}

/** The always-available fallback. Pure — no database or network access. */
export function generatedAvatar(params: {
  userId: string;
  style?: AvatarStyle | null;
  configDefaultStyle?: AvatarStyle | null;
  size?: number | null;
}): ResolvedAvatar {
  const style = resolveAvatarStyle({
    userId: params.userId,
    requested: params.style,
    configDefault: params.configDefaultStyle,
  });
  const svg = generateAvatarSvg({
    userId: params.userId,
    style,
    size: clampAvatarSize(params.size),
  });
  const body = Buffer.from(svg, 'utf8');

  return {
    source: 'generated',
    contentType: 'image/svg+xml; charset=utf-8',
    body,
    etag: etagFor(body),
    cacheControl: AVATAR_GENERATED_CACHE_CONTROL,
    filename: 'avatar.svg',
    isSvg: true,
  };
}

/**
 * Which of the three sources a user's avatar currently comes from, without fetching any bytes.
 * `provider` means "a provider URL is on file" — if proxying it later fails, that GET still
 * degrades to the generated image.
 */
export async function getAvatarSources(
  userIds: string[],
  deps?: AvatarDeps,
): Promise<Map<string, AvatarSource>> {
  const sources = new Map<string, AvatarSource>();
  if (userIds.length === 0) return sources;

  const prisma = prismaFor(deps);
  const [uploads, users] = await Promise.all([
    prisma.userAvatar.findMany({
      where: { userId: { in: userIds } },
      select: { userId: true },
    }),
    prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, avatarUrl: true },
    }),
  ]);

  const uploaded = new Set(uploads.map((row) => row.userId));
  for (const user of users) {
    sources.set(user.id, uploaded.has(user.id) ? 'uploaded' : user.avatarUrl ? 'provider' : 'generated');
  }

  return sources;
}

export async function getAvatarSource(userId: string, deps?: AvatarDeps): Promise<AvatarSource> {
  const sources = await getAvatarSources([userId], deps);
  return sources.get(userId) ?? 'generated';
}

/**
 * Store an uploaded avatar (Docs/Auth/avatars.md §3). The sniffed magic-byte type wins over the
 * client mimetype and is what gets persisted; SVG, HTML, PDF and anything else non-raster is
 * rejected with the standard generic error, as is anything over AVATAR_MAX_BYTES.
 */
export async function uploadAvatar(
  params: { userId: string; data: Buffer },
  deps?: AvatarDeps,
): Promise<AvatarUploadResult> {
  const prisma = prismaFor(deps);

  if (!Buffer.isBuffer(params.data) || params.data.byteLength === 0) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_AVATAR_UPLOAD');
  }
  if (params.data.byteLength > AVATAR_MAX_BYTES) {
    throw new AppError('BAD_REQUEST', 413, 'AVATAR_TOO_LARGE');
  }

  const contentType = sniffRasterImageType(params.data);
  if (!contentType) throw new AppError('BAD_REQUEST', 400, 'INVALID_AVATAR_UPLOAD');

  const user = await prisma.user.findUnique({
    where: { id: params.userId },
    select: { id: true },
  });
  if (!user) throw new AppError('NOT_FOUND', 404, 'USER_NOT_FOUND');

  const sizeBytes = params.data.byteLength;
  const data = toBytes(params.data);
  const row = await prisma.userAvatar.upsert({
    where: { userId: params.userId },
    create: { userId: params.userId, contentType, data, sizeBytes },
    update: { contentType, data, sizeBytes },
    select: { contentType: true, sizeBytes: true, updatedAt: true },
  });

  return {
    source: 'uploaded',
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    updatedAt: row.updatedAt,
  };
}

/**
 * Remove the uploaded avatar. Idempotent: deleting when nothing is stored still succeeds, and
 * resolution simply falls back to the provider URL or the generated image.
 */
export async function deleteAvatar(
  params: { userId: string },
  deps?: AvatarDeps,
): Promise<void> {
  const prisma = prismaFor(deps);
  await prisma.userAvatar.deleteMany({ where: { userId: params.userId } });
}
