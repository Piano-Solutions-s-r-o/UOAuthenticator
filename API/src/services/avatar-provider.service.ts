import { fetch as undiciFetch } from 'undici';

import {
  AVATAR_PROVIDER_DEADLINE_MS,
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

export type ProviderFetchDeps = {
  fetch?: ProviderFetch;
  /** Overall wall-clock budget for the whole operation. Tests inject a short one. */
  deadlineMs?: number;
};

/**
 * Fetch a social provider's avatar URL server-side (Docs/Auth/avatars.md §6).
 *
 * Deliberately fails soft: this returns `null` for *every* problem — non-HTTPS or oversized URL,
 * blocked/private destination, DNS failure, timeout, non-2xx, oversized body, or a response whose
 * bytes do not sniff as a raster image. The caller then serves the generated avatar with
 * `X-UOA-Avatar-Source: generated`, so an avatar GET is always a 200 with an image. Nothing here
 * is persisted — brief §22.7's "no caching of provider images" still holds.
 *
 * The URL is attacker-supplied (a user's provider profile, a manager's team `iconUrl`), so the
 * whole operation — DNS resolution, every sequential address attempt, the fetch, and the streamed
 * read — runs under one wall-clock deadline. No combination of slow steps can outlast it.
 */
export async function fetchProviderAvatar(
  avatarUrl: string | null | undefined,
  deps?: ProviderFetchDeps,
): Promise<ProviderAvatarImage | null> {
  const url = safeProviderUrl(avatarUrl);
  if (!url) return null;

  const doFetch = deps?.fetch ?? (undiciFetch as unknown as ProviderFetch);
  const deadlineMs =
    typeof deps?.deadlineMs === 'number' && deps.deadlineMs > 0
      ? deps.deadlineMs
      : AVATAR_PROVIDER_DEADLINE_MS;

  return withDeadline((signal) => fetchImage(url, doFetch, signal), deadlineMs);
}

/** https-only and length-bounded, same policy as team/org icon URLs. */
function safeProviderUrl(avatarUrl: string | null | undefined): URL | null {
  if (typeof avatarUrl !== 'string') return null;

  const safeUrl = parseIconUrl(avatarUrl);
  if (!safeUrl) return null;

  try {
    return parseHttpsUrl(safeUrl);
  } catch {
    return null;
  }
}

/**
 * Bound the whole operation on the wall clock rather than per leg.
 *
 * The signal is plumbed through every leg so an aborted attempt unwinds itself (releasing sockets
 * and closing agents) instead of lingering. The race is what makes the bound a *guarantee*: a leg
 * that ignores its signal — an unabortable DNS lookup, a hostile socket, an injected fetch — still
 * cannot hold the caller past the deadline.
 */
async function withDeadline(
  run: (signal: AbortSignal) => Promise<ProviderAvatarImage | null>,
  deadlineMs: number,
): Promise<ProviderAvatarImage | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const expired = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, deadlineMs);
  });

  // Never rejects: every failure in here is a `null` and the caller falls back to the generated
  // avatar. Past the deadline this promise keeps running only to unwind its own agent.
  const attempt = run(controller.signal).catch(() => null);

  try {
    return await Promise.race([attempt, expired]);
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
  }
}

async function fetchImage(
  url: URL,
  doFetch: ProviderFetch,
  signal: AbortSignal,
): Promise<ProviderAvatarImage | null> {
  let destinations;
  try {
    destinations = await resolvePublicDestinations(url);
  } catch {
    return null;
  }

  for (const destination of destinations) {
    if (signal.aborted) return null;

    const agent = createPinnedAgent(url, destination);
    try {
      const image = await requestImage(doFetch, url, agent, signal);
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
  signal: AbortSignal,
): Promise<ProviderAvatarImage | null> {
  const res = await doFetch(url.toString(), {
    method: 'GET',
    headers: { accept: 'image/*' },
    redirect: 'error',
    signal,
    dispatcher: agent,
  });

  // Every exit below — non-2xx, oversized, not-an-image, or a throw — has to leave the response
  // body released. An abandoned body keeps its request active on the pinned agent, and
  // `closeSsrfAgent` waits on exactly that, which is how a peer stalling its body used to hang the
  // caller. One `finally` covers every path, including the ones added later.
  try {
    if (!res.ok) return null;

    const body = await readCappedBody(res, AVATAR_PROVIDER_MAX_BYTES);
    if (!body) return null;

    // The advertised Content-Type is not trusted any more than an upload's is.
    const contentType = sniffRasterImageType(body);
    if (!contentType) return null;

    return { contentType, body };
  } finally {
    await releaseResponseBody(res);
  }
}

/**
 * Release whatever is left of a response body. A WHATWG `ReadableStream` (undici's `fetch`) is
 * cancelled; a Node stream is destroyed. A body that was already fully consumed needs neither, and
 * one that is still locked by an abandoned reader throws — both are fine outcomes here, because
 * the pinned agent is force-closed right after.
 */
async function releaseResponseBody(res: ProviderFetchResponse): Promise<void> {
  const body = res.body as
    | { cancel?: () => Promise<unknown>; destroy?: () => unknown; locked?: boolean }
    | null
    | undefined;
  if (!body || typeof body !== 'object') return;

  try {
    if (typeof body.cancel === 'function' && body.locked !== true) {
      await body.cancel();
      return;
    }
    if (typeof body.destroy === 'function') body.destroy();
  } catch {
    // Nothing left to release.
  }
}

/**
 * Read the response body, refusing anything over `max` bytes. Streams when the runtime gives us an
 * async-iterable body so an oversized response is abandoned mid-flight rather than fully buffered;
 * falls back to a buffered read (still size-checked) otherwise. Callers release the body.
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
