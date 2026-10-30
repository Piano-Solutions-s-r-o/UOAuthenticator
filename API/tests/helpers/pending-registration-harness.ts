import type { LightMyRequestResponse } from 'fastify';
import { expect, vi } from 'vitest';

import { createApp } from '../../src/app.js';
import { disconnectPrisma } from '../../src/db/prisma.js';
import { REGISTRATION_HANDOFF_COOKIE } from '../../src/services/registration-handoff.service.js';
import { baseClientConfigPayload, createTestConfigFetchHandler, signTestConfigJwt } from './test-config.js';
import { createTestDb } from './test-db.js';

export type Mailbox = { messages: Array<{ to: string; link: string; code: string }> };
export type Flow = { id: string; cookie: string; email: string; message: Mailbox['messages'][number] };

export const origin = 'http://127.0.0.1:38571';
export const configUrl = 'https://client.example.com/auth-config';
export const offConfigUrl = 'https://client.example.com/auth-config-off';
export const noRestartConfigUrl = 'https://client.example.com/auth-config-no-restart';
export const siblingConfigUrl = 'https://client.example.com/auth-config-sibling';
export const otherDomainConfigUrl = 'https://other.example.com/auth-config';
export const loginRestartUrl = 'https://client.example.com/login?start=1';
export const registrationRestartUrl = 'https://client.example.com/login?start=1&signup=1';
export const challengeA = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
export const challengeB = 'ZYXWVUTSRQPONMLKJIHGFEDCBAabcdefghijklmnopq';
export const password = 'a-strong-password-123';
// injectWS builds a plain request, and the upgrade's rate limit reads the peer address from it.
export const peer = { remoteAddress: '127.0.0.1' };

export function flowQuery(challenge = challengeA, url = configUrl): URLSearchParams {
  return new URLSearchParams({ config_url: url, code_challenge: challenge, code_challenge_method: 'S256' });
}
export const queryA = flowQuery();
export const queryB = flowQuery(challengeB);

export const onConfig = (overrides: Record<string, unknown> = {}) => baseClientConfigPayload({
  login_flow: { registration_code_enabled: true }, login_restart_url: loginRestartUrl,
  registration_restart_url: registrationRestartUrl, ...overrides,
});

/** The product side of a test: its signed configs by URL, replaceable mid-test. */
export async function createRegistrationHarness(mailbox: Mailbox, extraConfigs: Record<string, Record<string, unknown>> = {}) {
  const handle = await createTestDb();
  if (!handle) throw new Error('DATABASE_URL is required for registration persistence tests');
  const db = handle;
  const saved = { db: process.env.DATABASE_URL, admin: process.env.DATABASE_ADMIN_URL, base: process.env.PUBLIC_BASE_URL };
  process.env.DATABASE_URL = db.databaseUrl;
  process.env.DATABASE_ADMIN_URL = db.databaseUrl;
  process.env.PUBLIC_BASE_URL = origin;
  const configs: Record<string, string> = {
    [configUrl]: await signTestConfigJwt(onConfig()),
    [offConfigUrl]: await signTestConfigJwt(),
    [noRestartConfigUrl]: await signTestConfigJwt(baseClientConfigPayload({ login_flow: { registration_code_enabled: true } })),
    [siblingConfigUrl]: await signTestConfigJwt(onConfig({ language_config: 'cs' })),
    [otherDomainConfigUrl]: await signTestConfigJwt(onConfig({
      domain: 'other.example.com', redirect_urls: ['https://other.example.com/oauth/callback'],
      login_restart_url: 'https://other.example.com/login?start=1',
      registration_restart_url: 'https://other.example.com/login?start=1&signup=1',
    })),
  };
  for (const [url, payload] of Object.entries(extraConfigs)) configs[url] = await signTestConfigJwt(onConfig(payload));
  const handler = () => createTestConfigFetchHandler(configs);
  const stub = async () => { vi.stubGlobal('fetch', vi.fn(await handler())); };
  await stub();
  const app = await createApp();
  await app.ready();
  let sequence = 0;
  const ip = () => { sequence += 1; return `192.0.2.${sequence % 250 + 1}`; };
  const headers = (cookie = '') => ({ origin, cookie, 'x-forwarded-for': ip() });

  return {
    app, db,
    /** Replaces one product config and serves it from now on. */
    async setConfig(url: string, payload: Record<string, unknown>) {
      configs[url] = await signTestConfigJwt(onConfig(payload));
      await stub();
    },
    async close() {
      await app.close(); await disconnectPrisma();
      for (const [key, value] of [['DATABASE_URL', saved.db], ['DATABASE_ADMIN_URL', saved.admin], ['PUBLIC_BASE_URL', saved.base]] as const) {
        if (value === undefined) Reflect.deleteProperty(process.env, key); else process.env[key] = value;
      }
      vi.unstubAllGlobals();
      await db.cleanup();
    },
    /** The original window starts a registration with this email address. */
    async start(email = `registration-${sequence += 1}@example.com`, query = queryA): Promise<Flow> {
      const response = await app.inject({ method: 'POST', url: `/auth/registration/start?${query}`, payload: { email }, headers: headers() });
      expect(response.statusCode, response.body).toBe(200);
      const id = response.json().registration_id as string;
      return { id, cookie: String(response.headers['set-cookie']).split(';')[0], email, message: mailbox.messages.at(-1)! };
    },
    /** The window's "send again": same browser cookie, same address, same OAuth context. */
    async resend(flow: Flow, query = queryA): Promise<Flow> {
      const response = await app.inject({ method: 'POST', url: `/auth/registration/start?${query}`,
        payload: { email: flow.email, previous_id: flow.id }, headers: headers(flow.cookie) });
      expect(response.statusCode, response.body).toBe(200);
      return { id: response.json().registration_id as string, cookie: String(response.headers['set-cookie']).split(';')[0], email: flow.email, message: mailbox.messages.at(-1)! };
    },
    status(flow: Flow, cookie = flow.cookie, query = queryA) {
      return app.inject({ method: 'GET', url: `/auth/registration/status?${query}&id=${flow.id}`, headers: headers(cookie) });
    },
    /** What the link page posts after it reads the fragment. */
    link(flow: Flow, cookie = '') {
      return app.inject({ method: 'POST', url: '/auth/registration/link',
        payload: { token: new URL(flow.message.link).hash.slice(1) }, headers: headers(cookie) });
    },
    code(flow: Flow, value = flow.message.code, cookie = flow.cookie, query = queryA) {
      return app.inject({ method: 'POST', url: `/auth/registration/code?${query}`, payload: { id: flow.id, code: value }, headers: headers(cookie) });
    },
    /** The product's fresh sign-in, in the browser that opened the link. */
    auth(cookie: string, query: URLSearchParams | string = queryB) {
      return app.inject({ method: 'GET', url: `/auth?${query}`, headers: { cookie } });
    },
    /** The password form, without a token: the handoff cookie is the only reference to the registration. */
    finish(cookie: string, query = queryB, body: Record<string, unknown> = { password }) {
      return app.inject({ method: 'POST', url: `/auth/verify-email?${query}`, payload: body, headers: headers(cookie) });
    },
    /** The original window's own password, with the proof it gets after a code. */
    finishInWindow(flow: Flow, token: string, query = queryA) {
      return app.inject({ method: 'POST', url: `/auth/verify-email?${query}`, payload: { token, password }, headers: headers(flow.cookie) });
    },
    /** The original window, after it saw `complete`. */
    continueWindow(flow: Flow, cookie = flow.cookie, query = queryA) {
      return app.inject({ method: 'POST', url: `/auth/registration/continue?${query}`, payload: { id: flow.id }, headers: headers(cookie) });
    },
    /** Opens the link in a fresh browser and returns that browser's handoff cookie pair. */
    async open(flow: Flow): Promise<string> {
      const response = await app.inject({ method: 'POST', url: '/auth/registration/link',
        payload: { token: new URL(flow.message.link).hash.slice(1) }, headers: headers() });
      expect(response.json().status).toBe('continue');
      return handoffCookie(response).split(';')[0];
    },
  };
}

export type RegistrationHarness = Awaited<ReturnType<typeof createRegistrationHarness>>;

export function handoffCookie(response: LightMyRequestResponse): string {
  const headers = [response.headers['set-cookie']].flat().filter((value): value is string => typeof value === 'string');
  const header = headers.find(value => value.startsWith(`${REGISTRATION_HANDOFF_COOKIE}=`));
  if (!header) throw new Error('No handoff cookie in the response');
  return header;
}

export function offersPassword(html: string, email: string): boolean {
  return html.includes(`window.__UOA_REGISTRATION_HANDOFF__ = {"email":"${email}"}`);
}

export function codeOf(response: LightMyRequestResponse): string | null {
  return new URL(response.json().redirect_to as string).searchParams.get('code');
}
