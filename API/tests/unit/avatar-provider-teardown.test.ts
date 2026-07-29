import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { AVATAR_PROVIDER_MAX_BYTES } from '../../src/config/constants.js';
import { fetchProviderAvatar } from '../../src/services/avatar-provider.service.js';
import { closeSsrfAgent, createPinnedAgent } from '../../src/utils/ssrf.js';

/**
 * Teardown / deadline behaviour of the provider avatar proxy.
 *
 * These tests use a real HTTP server that sends response headers and then holds the socket open
 * without ever ending the body — the shape a malicious or broken `iconUrl`/`avatarUrl` host takes.
 * `tests/setup.ts` mocks `undici.fetch`, so the real one is imported here: the point is to drive a
 * genuine request through a genuine pinned agent, because the hang lived in the interaction
 * between an abandoned response body and the agent's graceful close.
 */

type UndiciModule = typeof import('undici');

let undici: UndiciModule;

beforeAll(async () => {
  undici = await vi.importActual<UndiciModule>('undici');
});

type StallingServer = {
  url: string;
  /** Resolves once the client tears the response socket down. */
  bodyReleased: Promise<void>;
};

/** Every server started by a test, torn down in `afterEach` so no socket outlives the file. */
const running: Server[] = [];

async function startStallingServer(head: {
  status: number;
  headers?: Record<string, string>;
  /** Bytes to emit before stalling. Defaults to a single token byte. */
  body?: Buffer;
}): Promise<StallingServer> {
  let releaseBody: () => void = () => {};
  const bodyReleased = new Promise<void>((resolve) => {
    releaseBody = resolve;
  });

  const server = createServer((_req, res) => {
    res.on('close', releaseBody);
    res.writeHead(head.status, head.headers ?? {});
    // Flush the headers plus the opening bytes, then never end the body.
    res.write(head.body ?? '.');
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  running.push(server);

  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/avatar.png`, bodyReleased };
}

afterEach(async () => {
  vi.restoreAllMocks();
  while (running.length) {
    const server = running.pop()!;
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
});

/** Fail fast and loudly instead of letting a hang burn the whole test timeout. */
async function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Relay the service's own request — same init, same pinned agent — at the local stalling server.
 * `127.0.0.1` is an IP literal, so Node connects directly and the agent's pinned lookup is bypassed;
 * the agent is still the one the service will later close, which is what makes the hang reproduce.
 */
function relayTo(server: StallingServer) {
  return (async (_url: string, init: Record<string, unknown>) =>
    undici.fetch(server.url, init as never)) as never;
}

const PROVIDER_URL = 'https://cdn.example.com/avatar.png';

/**
 * Upper bound that separates "the body was released" from "the body was abandoned".
 *
 * A released body lets the graceful `Agent.close()` settle at once — measured at 2–15ms. An
 * abandoned one cannot settle at all, so `closeSsrfAgent` must sit out its full 250ms grace window
 * before forcing the sockets down. 200ms is therefore below the hard floor of the broken path and
 * an order of magnitude above the working one. Without it these tests pass with
 * `releaseResponseBody` deleted, because the deadline and the bounded close still return a timely
 * `null` — the two halves of the fix would mask each other.
 */
const RELEASED_BODY_BUDGET_MS = 200;

describe('fetchProviderAvatar teardown', () => {
  it('returns null instead of hanging when a non-2xx response never ends its body', async () => {
    const server = await startStallingServer({ status: 404 });

    const started = Date.now();
    const result = await within(
      fetchProviderAvatar(PROVIDER_URL, { fetch: relayTo(server), deadlineMs: 2_000 }),
      3_000,
      'fetchProviderAvatar (404 with a stalled body)',
    );

    expect(result).toBeNull();
    expect(Date.now() - started).toBeLessThan(RELEASED_BODY_BUDGET_MS);
    await within(server.bodyReleased, 2_000, 'response body teardown');
  });

  it('returns null instead of hanging when an oversized declared body never ends', async () => {
    const server = await startStallingServer({
      status: 200,
      headers: {
        'content-type': 'image/png',
        'content-length': String(AVATAR_PROVIDER_MAX_BYTES + 1),
      },
    });

    const started = Date.now();
    const result = await within(
      fetchProviderAvatar(PROVIDER_URL, { fetch: relayTo(server), deadlineMs: 2_000 }),
      3_000,
      'fetchProviderAvatar (oversized content-length with a stalled body)',
    );

    expect(result).toBeNull();
    expect(Date.now() - started).toBeLessThan(RELEASED_BODY_BUDGET_MS);
    await within(server.bodyReleased, 2_000, 'response body teardown');
  });

  it('gives up on the overall deadline when the body stalls mid-stream', async () => {
    // The most realistic hostile shape: a 200 that starts sending real PNG bytes and then simply
    // stops. Nothing is oversized and nothing is malformed, so the streaming read itself is the
    // blocking leg — only the wall-clock deadline ends it.
    const server = await startStallingServer({
      status: 200,
      headers: { 'content-type': 'image/png' },
      body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    });

    const started = Date.now();
    const result = await within(
      fetchProviderAvatar(PROVIDER_URL, { fetch: relayTo(server), deadlineMs: 250 }),
      3_000,
      'fetchProviderAvatar (body that stalls mid-stream)',
    );

    expect(result).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
    await within(server.bodyReleased, 2_000, 'response body teardown');
  });

  it('gives up on the overall deadline when a leg ignores the abort signal', async () => {
    const neverSettles = vi.fn(() => new Promise<never>(() => {}));

    const started = Date.now();
    const result = await within(
      fetchProviderAvatar(PROVIDER_URL, { fetch: neverSettles as never, deadlineMs: 250 }),
      3_000,
      'fetchProviderAvatar (fetch that never settles)',
    );

    expect(result).toBeNull();
    // Well inside the 3s guard above, which would pass for any deadline up to 3s.
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(neverSettles).toHaveBeenCalledOnce();
  });
});

describe('closeSsrfAgent', () => {
  it('settles even while a response body is still in flight', async () => {
    const server = await startStallingServer({ status: 200 });
    const agent = createPinnedAgent(new URL(server.url), { address: '127.0.0.1', family: 4 });

    // Take the response but deliberately abandon its body: the request stays active on the agent,
    // which is exactly the state a graceful `Agent.close()` waits on forever.
    await undici.fetch(server.url, { dispatcher: agent } as never);

    await within(closeSsrfAgent(agent), 3_000, 'closeSsrfAgent with an in-flight body');
  });
});
