import { afterEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({ base: 'https://auth.example.com' }));
vi.mock('../../src/config/env.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/config/env.js')>(),
  getPublicBaseUrl: () => env.base,
}));

import { REGISTRATION_HANDOFF_TTL_MS } from '../../src/services/registration-credentials.js';
import {
  hasS256Challenge, REGISTRATION_HANDOFF_COOKIE, setRegistrationHandoffCookie,
} from '../../src/services/registration-handoff.service.js';

const id = '9466e365-206c-49cb-a8d5-aa1342bdd613';

function reply() {
  const setCookie = vi.fn();
  return { object: { setCookie } as never, setCookie };
}

afterEach(() => { env.base = 'https://auth.example.com'; vi.useRealTimers(); });

describe('registration handoff cookie', () => {
  it('is signed, HttpOnly, Lax, under /auth, host-only and Secure on https, with only id and times in it', () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const { object, setCookie } = reply();
    setRegistrationHandoffCookie(object, id, new Date(1_000_000 + 24 * 60 * 60 * 1000));
    const expires = 1_000_000 + REGISTRATION_HANDOFF_TTL_MS;
    expect(setCookie).toHaveBeenCalledExactlyOnceWith(REGISTRATION_HANDOFF_COOKIE, `${id}.1000000.${expires}`, {
      httpOnly: true, secure: true, sameSite: 'lax', path: '/auth', signed: true, maxAge: 3600,
    });
    expect(setCookie.mock.calls[0][2]).not.toHaveProperty('domain');
  });

  it('drops Secure only on an http origin, as local development needs', () => {
    env.base = 'http://127.0.0.1:3000';
    const { object, setCookie } = reply();
    setRegistrationHandoffCookie(object, id, new Date(Date.now() + 60 * 60 * 1000));
    expect(setCookie.mock.calls[0][2]).toMatchObject({ secure: false });
  });

  it('ends with the registration when that comes first', () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const { object, setCookie } = reply();
    setRegistrationHandoffCookie(object, id, new Date(1_000_000 + 30_000));
    expect(setCookie.mock.calls[0][1]).toBe(`${id}.1000000.1030000`);
    expect(setCookie.mock.calls[0][2]).toMatchObject({ maxAge: 30 });
  });
});

describe('hasS256Challenge', () => {
  const challenge = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';

  it('accepts exactly a well-formed S256 challenge', () => {
    expect(hasS256Challenge({ code_challenge: challenge, code_challenge_method: 'S256' })).toBe(true);
  });

  it.each([
    ['nothing', {}],
    ['no query', undefined],
    ['no method', { code_challenge: challenge }],
    ['no challenge', { code_challenge_method: 'S256' }],
    ['plain', { code_challenge: challenge, code_challenge_method: 'plain' }],
    ['a short challenge', { code_challenge: 'abc', code_challenge_method: 'S256' }],
    ['a repeated parameter', { code_challenge: [challenge, challenge], code_challenge_method: 'S256' }],
  ])('refuses %s without throwing', (_name, query) => {
    expect(hasS256Challenge(query)).toBe(false);
  });
});
