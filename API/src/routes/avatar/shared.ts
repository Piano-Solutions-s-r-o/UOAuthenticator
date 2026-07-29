import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { AVATAR_MAX_BYTES } from '../../config/constants.js';
import { configVerifier } from '../../middleware/config-verifier.js';
import { AVATAR_STYLES, isAvatarStyle, type AvatarStyle } from '../../utils/avatar-svg.js';
import { normalizeDomain } from '../../utils/domain.js';
import { AppError } from '../../utils/errors.js';
import type { AvatarUploadResult, ResolvedAvatar } from '../../services/avatar.service.js';

/** Shared `?style=` / `?size=` parsing for every avatar GET (Docs/Auth/avatars.md §2). */
export const AvatarImageQueryFields = {
  style: z.enum(AVATAR_STYLES).optional(),
  size: z.coerce.number().int().optional(),
} as const;

/** Multipart body limit: the 1 MiB image plus room for the multipart envelope itself. */
export const AVATAR_UPLOAD_BODY_LIMIT = AVATAR_MAX_BYTES + 32 * 1024;

/**
 * SVG is an active document format. Generated avatars contain no scripts or external references,
 * but the response says so explicitly so a browser cannot be talked into treating one as one.
 */
const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'";

/**
 * Write the image response contract from Docs/Auth/avatars.md §6. `X-UOA-Avatar-Source` carries the
 * resolved source so callers get that metadata without a second JSON round trip.
 */
export function sendAvatar(
  request: FastifyRequest,
  reply: FastifyReply,
  avatar: ResolvedAvatar,
): FastifyReply {
  reply
    .header('Content-Type', avatar.contentType)
    .header('X-UOA-Avatar-Source', avatar.source)
    .header('Cache-Control', avatar.cacheControl)
    .header('ETag', avatar.etag)
    .header('X-Content-Type-Options', 'nosniff')
    .header('Content-Disposition', `inline; filename="${avatar.filename}"`);

  if (avatar.isSvg) {
    reply.header('Content-Security-Policy', SVG_CSP);
  }

  const ifNoneMatch = request.headers['if-none-match'];
  if (typeof ifNoneMatch === 'string' && ifNoneMatch.trim() === avatar.etag) {
    return reply.status(304).send();
  }

  return reply.status(200).send(avatar.body);
}

/** JSON envelope for PUT (spec §5). Snake_case, like the rest of the `/domain` family. */
export function avatarUploadResponse(result: AvatarUploadResult) {
  return {
    ok: true,
    avatar: {
      source: result.source,
      content_type: result.contentType,
      size_bytes: result.sizeBytes,
      updated_at: result.updatedAt.toISOString(),
    },
  };
}

/**
 * Read the single `file` part of a multipart avatar upload. Mirrors the signature-PDF upload
 * shape; the client mimetype is intentionally *not* checked here — `uploadAvatar` sniffs the magic
 * bytes and that verdict is the only one that counts.
 */
export async function readAvatarUpload(request: FastifyRequest): Promise<Buffer> {
  try {
    // Per-request limit rather than the app-wide multipart one (which is sized for signature
    // PDFs): the stream is cut off at 1 MiB instead of buffering up to 25 MiB before we check.
    const file = await request.file({ limits: { fileSize: AVATAR_MAX_BYTES } });
    if (!file || file.fieldname !== 'file') {
      throw new AppError('BAD_REQUEST', 400, 'INVALID_AVATAR_UPLOAD');
    }
    return await file.toBuffer();
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === 'FST_REQ_FILE_TOO_LARGE') {
      throw new AppError('BAD_REQUEST', 413, 'AVATAR_TOO_LARGE');
    }
    if (err instanceof AppError) throw err;
    throw new AppError('BAD_REQUEST', 400, 'INVALID_AVATAR_UPLOAD');
  }
}

/**
 * Run the full `configVerifier` only when the request actually supplied `config_url`.
 *
 * On the avatar GETs the caller's authority is the domain-hash bearer (or the admin bearer); the
 * signed config only carries an optional preference, `avatars.default_style` (Docs/Auth/avatars.md
 * §2). This never relaxes verification — a supplied config is fetched and verified exactly as on
 * any other route, and a present-but-invalid one fails the request. An absent one simply means
 * "no configured preference".
 */
export async function optionalConfigVerifier(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const configUrl = (request.query as { config_url?: unknown } | undefined)?.config_url;
  if (typeof configUrl !== 'string' || !configUrl.trim()) return;

  await configVerifier(request, reply);
}

/**
 * The domain's configured default generated style, when the caller supplied a `config_url` that
 * `optionalConfigVerifier` already fetched and verified. A verified config for a *different*
 * domain than the authenticated one is a confusion of two trust sources and is rejected, matching
 * `requireDomainHashAuth`'s behaviour.
 */
export function configDefaultAvatarStyle(
  request: FastifyRequest,
  domain: string,
): AvatarStyle | null {
  const config = request.config;
  if (!config) return null;

  if (normalizeDomain(config.domain) !== normalizeDomain(domain)) {
    throw new AppError('UNAUTHORIZED', 401, 'CONFIG_DOMAIN_MISMATCH');
  }

  const style = (config as { avatars?: { default_style?: unknown } }).avatars?.default_style;
  return isAvatarStyle(style) ? style : null;
}
