import { describe, expect, it, vi } from 'vitest';

import { AVATAR_PROVIDER_MAX_BYTES } from '../../src/config/constants.js';
import { fetchProviderAvatar } from '../../src/services/avatar-provider.service.js';

const PROVIDER_URL = 'https://cdn.example.com/avatar.png';

function png(length = 64): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(length, 0x11),
  ]);
}

/** Minimal Response stand-in: enough surface for the capped read path. */
function response(options: {
  ok?: boolean;
  body: Buffer;
  contentLength?: string | null;
  stream?: boolean;
}) {
  const headers = new Map<string, string>();
  if (options.contentLength !== null) {
    headers.set('content-length', options.contentLength ?? String(options.body.byteLength));
  }

  const chunks = options.stream === false ? undefined : [options.body];

  return {
    ok: options.ok ?? true,
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    arrayBuffer: async () =>
      options.body.buffer.slice(
        options.body.byteOffset,
        options.body.byteOffset + options.body.byteLength,
      ) as ArrayBuffer,
    body: chunks
      ? {
          async *[Symbol.asyncIterator]() {
            for (const chunk of chunks) yield new Uint8Array(chunk);
          },
        }
      : null,
  };
}

describe('fetchProviderAvatar', () => {
  it('returns the sniffed raster image on success', async () => {
    const bytes = png();
    const fetch = vi.fn(async () => response({ body: bytes }));

    const result = await fetchProviderAvatar(PROVIDER_URL, { fetch: fetch as never });

    expect(result?.contentType).toBe('image/png');
    expect(result?.body.equals(bytes)).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('returns null without fetching for a null, http, or oversized URL', async () => {
    const fetch = vi.fn(async () => response({ body: png() }));

    expect(await fetchProviderAvatar(null, { fetch: fetch as never })).toBeNull();
    expect(await fetchProviderAvatar(undefined, { fetch: fetch as never })).toBeNull();
    expect(
      await fetchProviderAvatar('http://cdn.example.com/a.png', { fetch: fetch as never }),
    ).toBeNull();
    expect(
      await fetchProviderAvatar(`https://cdn.example.com/${'a'.repeat(3000)}.png`, {
        fetch: fetch as never,
      }),
    ).toBeNull();
    expect(await fetchProviderAvatar('not a url', { fetch: fetch as never })).toBeNull();

    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns null for a blocked (private/loopback) destination without fetching', async () => {
    const fetch = vi.fn(async () => response({ body: png() }));

    expect(
      await fetchProviderAvatar('https://127.0.0.1/avatar.png', { fetch: fetch as never }),
    ).toBeNull();
    expect(
      await fetchProviderAvatar('https://10.0.0.5/avatar.png', { fetch: fetch as never }),
    ).toBeNull();
    expect(
      await fetchProviderAvatar('https://[::1]/avatar.png', { fetch: fetch as never }),
    ).toBeNull();

    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns null on a non-2xx response', async () => {
    const fetch = vi.fn(async () => response({ ok: false, body: png() }));
    expect(await fetchProviderAvatar(PROVIDER_URL, { fetch: fetch as never })).toBeNull();
  });

  it('returns null when the fetch throws (timeout, DNS, TLS)', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('ETIMEDOUT');
    });
    expect(await fetchProviderAvatar(PROVIDER_URL, { fetch: fetch as never })).toBeNull();
  });

  it('returns null when the response is not a raster image', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
    const fetch = vi.fn(async () => response({ body: svg }));
    expect(await fetchProviderAvatar(PROVIDER_URL, { fetch: fetch as never })).toBeNull();
  });

  it('refuses an oversized declared content-length before reading the body', async () => {
    const fetch = vi.fn(async () =>
      response({ body: png(), contentLength: String(AVATAR_PROVIDER_MAX_BYTES + 1) }),
    );
    expect(await fetchProviderAvatar(PROVIDER_URL, { fetch: fetch as never })).toBeNull();
  });

  it('refuses an oversized body that lied about its length', async () => {
    const huge = png(AVATAR_PROVIDER_MAX_BYTES + 1024);
    const fetch = vi.fn(async () => response({ body: huge, contentLength: null }));
    expect(await fetchProviderAvatar(PROVIDER_URL, { fetch: fetch as never })).toBeNull();
  });

  it('still works when the runtime gives a non-iterable body', async () => {
    const bytes = png();
    const fetch = vi.fn(async () => response({ body: bytes, stream: false }));

    const result = await fetchProviderAvatar(PROVIDER_URL, { fetch: fetch as never });
    expect(result?.contentType).toBe('image/png');
  });

  it('never follows redirects', async () => {
    const fetch = vi.fn(async (_url: string, init: Record<string, unknown>) => {
      expect(init.redirect).toBe('error');
      return response({ body: png() });
    });

    await fetchProviderAvatar(PROVIDER_URL, { fetch: fetch as never });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
