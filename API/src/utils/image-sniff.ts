/**
 * Magic-byte raster image sniffing (Docs/Auth/avatars.md §3).
 *
 * The client-supplied multipart mimetype is never trusted: an `image/png` label on an SVG or HTML
 * payload is exactly the stored-XSS case this exists to stop. The sniffed type wins, is what gets
 * persisted in `user_avatars.content_type`, and is what is served back with `nosniff`. Anything
 * that is not PNG, JPEG or WebP is rejected by the caller with the standard generic error.
 *
 * Pure and dependency-free; no I/O.
 */

export const RASTER_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

export type RasterImageType = (typeof RASTER_IMAGE_TYPES)[number];

/** File extension used for the inline `Content-Disposition` filename. */
export function rasterImageExtension(contentType: string): string {
  switch (contentType) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpg';
    case 'image/webp':
      return 'webp';
    default:
      return 'bin';
  }
}

function startsWith(buffer: Buffer, bytes: readonly number[]): boolean {
  if (buffer.length < bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    if (buffer[i] !== bytes[i]) return false;
  }
  return true;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
// SOI + the first marker byte. Every JPEG variant (JFIF, Exif, raw) starts this way.
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff] as const;
const RIFF_SIGNATURE = [0x52, 0x49, 0x46, 0x46] as const; // "RIFF"
const WEBP_FOURCC = [0x57, 0x45, 0x42, 0x50] as const; // "WEBP" at offset 8

/**
 * Return the sniffed raster type, or null when the bytes are not a supported raster image.
 * Never throws — callers turn null into a generic rejection.
 */
export function sniffRasterImageType(buffer: Buffer): RasterImageType | null {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;

  if (startsWith(buffer, PNG_SIGNATURE)) return 'image/png';
  if (startsWith(buffer, JPEG_SIGNATURE)) return 'image/jpeg';

  if (startsWith(buffer, RIFF_SIGNATURE)) {
    const fourCc = buffer.subarray(8, 12);
    const matches = WEBP_FOURCC.every((byte, index) => fourCc[index] === byte);
    if (matches) return 'image/webp';
  }

  return null;
}

export function isRasterImageType(value: unknown): value is RasterImageType {
  return typeof value === 'string' && (RASTER_IMAGE_TYPES as readonly string[]).includes(value);
}
