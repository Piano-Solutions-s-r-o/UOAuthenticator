import { fetch as undiciFetch } from 'undici';

import {
  AVATAR_PROVIDER_FETCH_TIMEOUT_MS,
  AVATAR_PROVIDER_MAX_BYTES,
} from '../config/constants.js';
import { parseIconUrl } from '../utils/http-url.js';
import { sniffRasterImageType, type RasterImageType } from '../utils/image-sniff.js';
import {
  closeSsrfAgent,
  createPinnedAgent,
  parseHttpsUrl,
  resolvePublicDestinations,
} from '../utils/ssrf.js';

export type ProviderAvatarImage = {
  contentType: RasterImageType;
  body: Buffer;
};

type ProviderFetchResponse = {
  ok: boolean;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
  body?: unknown;
};

type ProviderFetch = (
  url: string,
  init: Record<string, unknown>,
) => Promise<ProviderFetchResponse>;

/**
 * Fetch a social provider's avatar URL server-side (Docs/Auth/avatars.md §6).
 *
 * Deliberately fails soft: this returns `null` for *every* problem — non-HTTPS or oversized URL,
 * blocked/private destination, DNS failure, timeout, non-2xx, oversized body, or a response whose
 * bytes do not sniff as a raster image. The caller then serves the generated avatar with
 * `X-UOA-Avatar-Source: generated`, so an avatar GET is always a 200 with an image. Nothing here
 * is persisted — brief §22.7's "no caching of provider images" still holds.
 */
export async function fetchProviderAvatar(
  avatarUrl: string | null | undefined,
  deps?: { fetch?: ProviderFetch },
): Promise<ProviderAvatarImage | null> {
  if (typeof avatarUrl !== 'string') return null;

  // https-only and length-bounded, same policy as team/org icon URLs.
  const safeUrl = parseIconUrl(avatarUrl);
  if (!safeUrl) return null;

  let url: URL;
  try {
    url = parseHttpsUrl(safeUrl);
  } catch {
    return null;
  }

  const doFetch = deps?.fetch ?? (undiciFetch as unknown as ProviderFetch);

  let destinations;
  try {
    destinations = await resolvePublicDestinations(url);
  } catch {
    return null;
  }

  for (const destination of destinations) {
    const agent = createPinnedAgent(url, destination);
    try {
      const image = await requestImage(doFetch, url, agent);
      if (image) return image;
    } catch {
      // Try the next resolved address; a total failure ends as `null` below.
    } finally {
      await closeSsrfAgent(agent);
    }
  }

  return null;
}

async function requestImage(
  doFetch: ProviderFetch,
  url: URL,
  agent: unknown,
): Promise<ProviderAvatarImage | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AVATAR_PROVIDER_FETCH_TIMEOUT_MS);

  try {
    const res = await doFetch(url.toString(), {
      method: 'GET',
      headers: { accept: 'image/*' },
      redirect: 'error',
      signal: controller.signal,
      dispatcher: agent,
    });

    if (!res.ok) return null;

    const body = await readCappedBody(res, AVATAR_PROVIDER_MAX_BYTES);
    if (!body) return null;

    // The advertised Content-Type is not trusted any more than an upload's is.
    const contentType = sniffRasterImageType(body);
    if (!contentType) return null;

    return { contentType, body };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read the response body, refusing anything over `max` bytes. Streams when the runtime gives us an
 * async-iterable body so an oversized response is abandoned mid-flight rather than fully buffered;
 * falls back to a buffered read (still size-checked) otherwise.
 */
async function readCappedBody(res: ProviderFetchResponse, max: number): Promise<Buffer | null> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) return null;

  const stream = res.body as AsyncIterable<Uint8Array> | null | undefined;
  if (!stream || typeof (stream as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] !== 'function') {
    const buffered = Buffer.from(await res.arrayBuffer());
    return buffered.byteLength > max ? null : buffered;
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.byteLength;
    if (total > max) return null;
    chunks.push(Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}
