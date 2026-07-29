import { createHash } from 'node:crypto';

import {
  AVATAR_DYNAMIC_CACHE_CONTROL,
  AVATAR_GENERATED_CACHE_CONTROL,
  AVATAR_MAX_BYTES,
} from '../config/constants.js';
import {
  clampAvatarSize,
  generateAvatarSvg,
  resolveAvatarStyle,
  type AvatarStyle,
} from '../utils/avatar-svg.js';
import { AppError } from '../utils/errors.js';
import { rasterImageExtension, sniffRasterImageType } from '../utils/image-sniff.js';
import { fetchProviderAvatar, type ProviderAvatarImage } from './avatar-provider.service.js';

/**
 * The source-agnostic half of the avatar system (Docs/Auth/avatars.md §1 and §11).
 *
 * Users and teams have identical avatar semantics — uploaded bytes → an external URL proxied
 * server-side → a deterministic generated SVG — over different tables and different external URL
 * columns (`users.avatar_url` vs `teams.icon_url`). Everything that does not depend on *which*
 * entity it is lives here and is shared by `avatar.service.ts` and `team-avatar.service.ts`, so the
 * precedence, ETag, cache and upload-validation rules exist in exactly one place.
 */

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

/** The stored upload row, narrowed to what resolution needs. */
export type UploadedAvatarRow = { contentType: string; data: Uint8Array } | null | undefined;

/**
 * What resolution needs to know about the thing being pictured: an id to seed the generated SVG,
 * the uploaded row if there is one, and the externally hosted URL to proxy when there is not.
 */
export type AvatarSubject = {
  id: string;
  uploaded: UploadedAvatarRow;
  externalUrl: string | null | undefined;
};

export type AvatarStyleOptions = {
  style?: AvatarStyle | null;
  configDefaultStyle?: AvatarStyle | null;
  size?: number | null;
};

export type AvatarProviderDeps = {
  fetchProvider?: (url: string | null | undefined) => Promise<ProviderAvatarImage | null>;
};

export function etagFor(body: Buffer): string {
  return `"sha256-${createHash('sha256').update(body).digest('hex')}"`;
}

// Prisma's `Bytes` column typing requires `Uint8Array<ArrayBuffer>`; Node `Buffer` is structurally
// compatible but TS sees `Buffer<ArrayBufferLike>`. Copy at the persistence boundary, same as
// `integration-claim.service.ts`.
export function toAvatarBytes(buf: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(buf.byteLength));
  out.set(buf);
  return out;
}

/**
 * Fixed precedence (Docs/Auth/avatars.md §1): uploaded → proxied external URL → generated. Callers
 * establish that the subject exists (and that the caller may see it) before calling this; a subject
 * that resolves here always yields an image.
 */
export async function resolveSubjectAvatar(
  subject: AvatarSubject,
  options: AvatarStyleOptions = {},
  deps?: AvatarProviderDeps,
): Promise<ResolvedAvatar> {
  if (subject.uploaded) {
    const body = Buffer.from(subject.uploaded.data);
    return {
      source: 'uploaded',
      contentType: subject.uploaded.contentType,
      body,
      etag: etagFor(body),
      cacheControl: AVATAR_DYNAMIC_CACHE_CONTROL,
      filename: `avatar.${rasterImageExtension(subject.uploaded.contentType)}`,
      isSvg: false,
    };
  }

  if (subject.externalUrl) {
    const fetchProvider = deps?.fetchProvider ?? fetchProviderAvatar;
    // Never throws — a failed fetch is indistinguishable from "no external image".
    const proxied = await fetchProvider(subject.externalUrl);
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

  return generatedAvatar(subject.id, options);
}

/** The always-available fallback. Pure — no database or network access. */
export function generatedAvatar(
  subjectId: string,
  options: AvatarStyleOptions = {},
): ResolvedAvatar {
  const style = resolveAvatarStyle({
    userId: subjectId,
    requested: options.style,
    configDefault: options.configDefaultStyle,
  });
  const svg = generateAvatarSvg({
    userId: subjectId,
    style,
    size: clampAvatarSize(options.size),
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
 * Validate uploaded bytes (Docs/Auth/avatars.md §3) and return the type to persist. The sniffed
 * magic-byte verdict wins over any client mimetype; SVG, HTML, PDF and anything else non-raster is
 * rejected with the standard generic error, as is anything over `AVATAR_MAX_BYTES`.
 */
export function sniffAvatarUpload(data: Buffer): string {
  if (!Buffer.isBuffer(data) || data.byteLength === 0) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_AVATAR_UPLOAD');
  }
  if (data.byteLength > AVATAR_MAX_BYTES) {
    throw new AppError('BAD_REQUEST', 413, 'AVATAR_TOO_LARGE');
  }

  const contentType = sniffRasterImageType(data);
  if (!contentType) throw new AppError('BAD_REQUEST', 400, 'INVALID_AVATAR_UPLOAD');

  return contentType;
}

/** Which source a subject's avatar currently comes from, without fetching any bytes. */
export function avatarSourceFor(
  hasUpload: boolean,
  externalUrl: string | null | undefined,
): AvatarSource {
  if (hasUpload) return 'uploaded';
  return externalUrl ? 'provider' : 'generated';
}
