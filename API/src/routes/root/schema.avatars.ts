import type { EndpointSchema } from './schema.js';

const IMAGE_RESPONSE: Record<string, string> = {
  'content-type':
    'image/svg+xml; charset=utf-8 for generated avatars, or the stored/sniffed raster type (image/png | image/jpeg | image/webp) for uploaded and proxied provider images',
  'X-UOA-Avatar-Source':
    '"uploaded" | "provider" | "generated" — where the returned bytes came from',
  'Cache-Control':
    'private, max-age=300 (uploaded/proxied) or private, max-age=86400 (generated, deterministic)',
  ETag: 'SHA-256 of the returned bytes; a matching If-None-Match gets 304',
  'X-Content-Type-Options': 'nosniff',
  'Content-Disposition': 'inline; filename="avatar.<ext>"',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline' — SVG responses only",
  body: 'raw image bytes — avatar GETs never return JSON',
};

const IMAGE_QUERY: Record<string, string> = {
  'style?':
    'string — tiles | waves | rings | mono; overrides the config default and the per-user pick. Only affects generated avatars.',
  'size?':
    'number — generated SVG width/height, clamped 16-512 (default 128). The viewBox is constant; ignored for raster images.',
};

const UPLOAD_BODY: Record<string, string> = {
  file: 'multipart/form-data file part — PNG, JPEG or WebP, max 1 MiB. The type is decided by magic-byte sniffing, not the supplied mimetype; SVG and any non-raster upload is rejected with a generic error.',
};

const UPLOAD_RESPONSE: Record<string, string> = {
  ok: 'true',
  'avatar.source': '"uploaded"',
  'avatar.content_type': 'string — the sniffed type that was stored',
  'avatar.size_bytes': 'number',
  'avatar.updated_at': 'string — ISO timestamp',
};

const RESOLUTION_NOTE =
  'Resolution precedence is fixed: uploaded image → server-side proxy of the provider avatar URL ' +
  '(User.avatarUrl) → deterministic generated SVG. The provider fetch is HTTPS-only, SSRF-guarded, ' +
  '~5s/5 MiB capped, and any failure silently falls back to the generated image, so a known user ' +
  'always yields 200 with an image. Provider bytes are never stored.';

export const avatarEndpoints: EndpointSchema[] = [
  {
    method: 'GET',
    path: '/domain/users/:userId/avatar',
    description:
      "Image bytes for a user visible to the authenticated domain. Unknown or cross-domain user ids return the standard generic 404 (same visibility as GET /domain/users).",
    auth: 'domain hash bearer token',
    query: {
      domain: 'string (required)',
      'config_url?':
        'string — optional; when supplied the signed config is fetched and verified and its avatars.default_style is applied. Its domain claim must match ?domain=.',
      ...IMAGE_QUERY,
    },
    response: IMAGE_RESPONSE,
    notes: RESOLUTION_NOTE,
  },
  {
    method: 'PUT',
    path: '/domain/users/:userId/avatar',
    description:
      "Set a user's uploaded avatar from a multipart upload. Replaces any existing upload. Rate-limited per domain+user (30/hour).",
    auth: 'domain hash bearer token',
    query: { domain: 'string (required)' },
    body: UPLOAD_BODY,
    response: UPLOAD_RESPONSE,
  },
  {
    method: 'DELETE',
    path: '/domain/users/:userId/avatar',
    description:
      "Remove a user's uploaded avatar; resolution falls back to the provider URL or the generated image. Idempotent. Rate-limited per domain+user (30/hour).",
    auth: 'domain hash bearer token',
    query: { domain: 'string (required)' },
    response: { ok: 'true' },
  },
  {
    method: 'GET',
    path: '/avatar/me',
    description:
      "Image bytes for the access-token subject — the end user's own avatar, relayed by a product backend.",
    auth: 'domain hash bearer token + access token (X-UOA-Access-Token header)',
    query: {
      domain: 'string (required) — must equal the access token\'s domain claim',
      'config_url?': 'string — optional; applies the domain\'s avatars.default_style',
      ...IMAGE_QUERY,
    },
    response: IMAGE_RESPONSE,
    notes: RESOLUTION_NOTE,
  },
  {
    method: 'PUT',
    path: '/avatar/me',
    description:
      "Set the caller's own avatar from a multipart upload. The acting identity is always the access-token subject. Rate-limited per domain+user (30/hour).",
    auth: 'domain hash bearer token + access token (X-UOA-Access-Token header)',
    query: { domain: 'string (required) — must equal the access token\'s domain claim' },
    body: UPLOAD_BODY,
    response: UPLOAD_RESPONSE,
  },
  {
    method: 'DELETE',
    path: '/avatar/me',
    description:
      "Clear the caller's own uploaded avatar. Rate-limited per domain+user (30/hour).",
    auth: 'domain hash bearer token + access token (X-UOA-Access-Token header)',
    query: { domain: 'string (required) — must equal the access token\'s domain claim' },
    response: { ok: 'true' },
  },
  {
    method: 'GET',
    path: '/internal/admin/users/:userId/avatar',
    description: 'Image bytes for any user, for the admin panel. Same resolution pipeline.',
    auth: 'admin superuser bearer token',
    query: IMAGE_QUERY,
    response: IMAGE_RESPONSE,
    notes: RESOLUTION_NOTE,
  },
];
