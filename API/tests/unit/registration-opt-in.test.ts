import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { isAppError } from '../../src/utils/errors.js';

// HUGO-2261: the browser-bound registration flow ships switched off and is enabled per product by
// `login_flow.registration_code_enabled` plus `registration_restart_url` in the signed config. The
// real registrationContext (the one place every entry point builds its context) is exercised here;
// only the services are mocked.
const mocks = vi.hoisted(() => ({
  start: vi.fn(), state: vi.fn(), code: vi.fn(), link: vi.fn(), resume: vi.fn(), funnel: vi.fn(),
}));
vi.mock('../../src/config/env.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/config/env.js')>(),
  getPublicBaseUrl: () => 'https://auth.example.com',
}));
vi.mock('../../src/services/pending-registration.service.js', () => ({
  startPendingRegistration: mocks.start,
  pendingRegistrationState: mocks.state,
  verifyPendingRegistrationCode: mocks.code,
  openPendingRegistrationLink: mocks.link,
  continuePendingRegistration: mocks.resume,
}));
vi.mock('../../src/services/auth-funnel.service.js', () => ({ recordAuthFunnelStep: mocks.funnel }));
import { registerPendingRegistrationRoutes } from '../../src/routes/auth/registration.js';
import { registerRegistrationWebSocket } from '../../src/routes/auth/registration-websocket.js';
import { registrationContext } from '../../src/routes/auth/registration-context.js';
import {
  configFetchRateLimiter,
  registerRateLimiter,
  registrationStatusRateLimiter,
  registrationCodeRateLimiter,
  registrationContinueRateLimiter,
  registrationLinkRateLimiter,
  registrationStartRateLimiter,
  tokenConsumeRateLimiter,
  verifyCodeRateLimiter,
} from '../../src/routes/auth/rate-limit-keys.js';

type Handler = (request: unknown, reply: unknown) => Promise<unknown>;

const id = '9466e365-206c-49cb-a8d5-aa1342bdd613';
const query = {
  config_url: 'https://client.example.com/auth-config',
  code_challenge: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ',
  code_challenge_method: 'S256',
};
const flows = {
  absent: undefined,
  empty: {},
  explicitlyOff: { registration_code_enabled: false },
  otherFlagOnly: { email_code_enabled: true, registration_code_enabled: false },
} as const;

const RESTART_URL = 'https://client.example.com/login?start=1&signup=1';

function request(loginFlow: unknown, extra: Record<string, unknown> = {}) {
  return {
    query: { ...query, ...(extra.query as object | undefined) }, body: extra.body ?? {}, headers: {}, cookies: {},
    config: {
      domain: 'client.example.com', registration_restart_url: RESTART_URL,
      ...(loginFlow === undefined ? {} : { login_flow: loginFlow }), ...(extra.config as object | undefined),
    },
    configUrl: query.config_url, adminDb: {}, ip: '127.0.0.1',
  };
}

function reply() {
  const state = { cookie: false };
  const object = {
    header: () => object, code: () => object, send: () => object,
    setCookie: () => { state.cookie = true; return object; },
  };
  return { object, state };
}

function routes() {
  const handlers = new Map<string, Handler>();
  registerPendingRegistrationRoutes({
    get: (path: string, _o: unknown, h?: Handler) => { handlers.set(`GET ${path}`, h ?? (_o as Handler)); },
    post: (path: string, _o: unknown, h: Handler) => { handlers.set(`POST ${path}`, h); },
  } as unknown as FastifyInstance);
  return handlers;
}

function eventsPreHandlers(): Array<(request: unknown) => Promise<void>> {
  let options: { preHandler: Array<(request: unknown) => Promise<void>> } | undefined;
  registerRegistrationWebSocket({
    get: (_path: string, o: unknown) => { options = o as typeof options; },
  } as unknown as FastifyInstance);
  if (!options) throw new Error('events route was not registered');
  return options.preHandler;
}

async function refusal(run: Promise<unknown>) {
  const error = await run.then(() => undefined, (e: unknown) => e);
  expect(isAppError(error)).toBe(true);
  expect(error).toMatchObject({ statusCode: 400, message: 'REGISTRATION_UNAVAILABLE' });
}

beforeEach(() => {
  Object.values(mocks).forEach(mock => mock.mockReset());
  mocks.start.mockResolvedValue({ id, credential: 'c', expiresAt: new Date(0), status: 'sent', delivery: 'verification_sent' });
  mocks.state.mockResolvedValue({ status: 'pending' });
  mocks.code.mockResolvedValue(undefined);
});

describe('registrationContext', () => {
  it.each(Object.entries(flows))('refuses with the generic registration error when login_flow is %s', (_name, loginFlow) => {
    expect(() => registrationContext(request(loginFlow) as never)).toThrowError('REGISTRATION_UNAVAILABLE');
  });

  it('refuses the flag alone: without a registration restart URL the flow behaves as off', () => {
    const missing = request({ registration_code_enabled: true }, { config: { registration_restart_url: undefined } });
    expect(() => registrationContext(missing as never)).toThrowError('REGISTRATION_UNAVAILABLE');
  });

  it('builds the context once the signed config opts in', () => {
    const context = registrationContext(request({ registration_code_enabled: true }) as never);
    expect(context).toMatchObject({ configUrl: query.config_url, codeChallengeMethod: 'S256', requestAccess: false });
  });
});

describe.each(Object.entries(flows))('with the flag off (login_flow %s)', (_name, loginFlow) => {
  it('start refuses before any row, email, counter or cookie', async () => {
    const answer = reply();
    await refusal(routes().get('POST /auth/registration/start')!(request(loginFlow, { body: { email: 'a@b.cz' } }), answer.object));
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.funnel).not.toHaveBeenCalled();
    expect(answer.state.cookie).toBe(false);
  });

  it('status refuses without reading a registration', async () => {
    await refusal(routes().get('GET /auth/registration/status')!(request(loginFlow, { query: { id } }), reply().object));
    expect(mocks.state).not.toHaveBeenCalled();
  });

  it('code refuses without checking the code or spending an attempt', async () => {
    await refusal(routes().get('POST /auth/registration/code')!(request(loginFlow, { body: { id, code: 'AB3K7M' } }), reply().object));
    expect(mocks.code).not.toHaveBeenCalled();
  });

  it('continue refuses without reading a registration', async () => {
    await refusal(routes().get('POST /auth/registration/continue')!(request(loginFlow, { body: { id } }), reply().object));
    expect(mocks.resume).not.toHaveBeenCalled();
  });

  it('events refuse before the WebSocket upgrade', async () => {
    const [, , , afterConfig] = eventsPreHandlers();
    await refusal(afterConfig!(request(loginFlow, { query: { id } })));
    expect(mocks.state).not.toHaveBeenCalled();
  });
});

describe('with the flag on', () => {
  const enabled = { registration_code_enabled: true };

  it('start creates the pending registration and sets the cookie', async () => {
    const answer = reply();
    await routes().get('POST /auth/registration/start')!(request(enabled, { body: { email: 'a@b.cz' } }), answer.object);
    expect(mocks.start).toHaveBeenCalledOnce();
    expect(mocks.funnel).toHaveBeenCalled();
    expect(answer.state.cookie).toBe(true);
  });

  it('status and code reach their services', async () => {
    await routes().get('GET /auth/registration/status')!(request(enabled, { query: { id } }), reply().object);
    expect(mocks.state).toHaveBeenCalledOnce();
    await routes().get('POST /auth/registration/code')!(request(enabled, { body: { id, code: 'ab3k7m' } }), reply().object);
    expect(mocks.code).toHaveBeenCalledWith(expect.objectContaining({ id, code: 'AB3K7M' }), {});
  });

  it('events pass the context preHandler', async () => {
    const [, , , afterConfig] = eventsPreHandlers();
    await afterConfig!(request(enabled, { query: { id } }));
    expect(mocks.state).toHaveBeenCalledOnce();
  });
});

describe('rate-limit namespaces', () => {
  function limiterOf(path: string): unknown {
    let options: { preHandler?: unknown[] } | undefined;
    const record = (route: string, o: unknown) => { if (route === path) options = o as typeof options; };
    registerPendingRegistrationRoutes({
      get: (route: string, o: unknown) => record(route, o),
      post: (route: string, o: unknown) => record(route, o),
    } as unknown as FastifyInstance);
    // preHandler order is [same-origin check, limiter, config verifier] (the link: [same-origin, limiter]).
    return options?.preHandler?.[1];
  }

  it('gives start, code and link their own budgets instead of the register, verify-code and token ones', () => {
    expect(limiterOf('/auth/registration/start')).toBe(registrationStartRateLimiter);
    expect(limiterOf('/auth/registration/start')).not.toBe(registerRateLimiter);
    expect(limiterOf('/auth/registration/code')).toBe(registrationCodeRateLimiter);
    expect(limiterOf('/auth/registration/code')).not.toBe(verifyCodeRateLimiter);
    expect(limiterOf('/auth/registration/link')).toBe(registrationLinkRateLimiter);
    expect(limiterOf('/auth/registration/link')).not.toBe(tokenConsumeRateLimiter);
    expect(limiterOf('/auth/registration/continue')).toBe(registrationContinueRateLimiter);
    expect(limiterOf('/auth/registration/continue')).not.toBe(registrationStatusRateLimiter);
  });

  // Each poll and upgrade verifies the product config, which is an outbound fetch, so both are
  // limited, but on their own budget: waiting windows must not use up the /auth page load's.
  it('gives the status poll and the events upgrade one budget of their own', () => {
    expect(limiterOf('/auth/registration/status')).toBe(registrationStatusRateLimiter);
    expect(eventsPreHandlers()[1]).toBe(registrationStatusRateLimiter);
    expect(registrationStatusRateLimiter).not.toBe(configFetchRateLimiter);
  });
});
