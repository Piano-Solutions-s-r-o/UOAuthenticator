import { afterEach, describe, expect, it } from 'vitest';

import {
  adminAvatarImageUrl,
  avatarImageBaseUrl,
  domainAvatarImageUrl,
} from '../../src/utils/avatar-url.js';

// Docs/Auth/avatars.md §9: every identity payload carries a URL that resolves to an image and is
// fetchable with the same credential class the caller already used.
describe('avatar image URL builders', () => {
  const originalPublicBaseUrl = process.env.PUBLIC_BASE_URL;

  afterEach(() => {
    if (originalPublicBaseUrl === undefined) Reflect.deleteProperty(process.env, 'PUBLIC_BASE_URL');
    else process.env.PUBLIC_BASE_URL = originalPublicBaseUrl;
  });

  it('builds an absolute domain-hash URL from the configured base', () => {
    expect(
      domainAvatarImageUrl({
        baseUrl: 'https://auth.example.com',
        domain: 'client.example.com',
        userId: 'user_1',
      }),
    ).toBe('https://auth.example.com/domain/users/user_1/avatar?domain=client.example.com');
  });

  it('builds an absolute admin URL from the configured base', () => {
    expect(adminAvatarImageUrl({ baseUrl: 'https://auth.example.com', userId: 'user_1' })).toBe(
      'https://auth.example.com/internal/admin/users/user_1/avatar',
    );
  });

  it('strips trailing slashes from the base so paths never double up', () => {
    expect(adminAvatarImageUrl({ baseUrl: 'https://auth.example.com///', userId: 'user_1' })).toBe(
      'https://auth.example.com/internal/admin/users/user_1/avatar',
    );
    expect(
      domainAvatarImageUrl({
        baseUrl: 'https://auth.example.com/',
        domain: 'client.example.com',
        userId: 'user_1',
      }),
    ).toBe('https://auth.example.com/domain/users/user_1/avatar?domain=client.example.com');
  });

  it('falls back to a root-relative path when no base URL is configured', () => {
    expect(
      domainAvatarImageUrl({ baseUrl: undefined, domain: 'client.example.com', userId: 'user_1' }),
    ).toBe('/domain/users/user_1/avatar?domain=client.example.com');
    expect(adminAvatarImageUrl({ baseUrl: '', userId: 'user_1' })).toBe(
      '/internal/admin/users/user_1/avatar',
    );
    expect(adminAvatarImageUrl({ baseUrl: null, userId: 'user_1' })).toBe(
      '/internal/admin/users/user_1/avatar',
    );
  });

  it('URL-encodes every interpolated segment and parameter', () => {
    expect(
      domainAvatarImageUrl({
        baseUrl: 'https://auth.example.com',
        domain: 'client.example.com/evil?x=1',
        userId: 'a/b?c=d#e',
      }),
    ).toBe(
      'https://auth.example.com/domain/users/a%2Fb%3Fc%3Dd%23e/avatar' +
        '?domain=client.example.com%2Fevil%3Fx%3D1',
    );
    expect(adminAvatarImageUrl({ baseUrl: '', userId: '../../secret' })).toBe(
      '/internal/admin/users/..%2F..%2Fsecret/avatar',
    );
  });

  it('reads PUBLIC_BASE_URL for the base and never throws when it is unset', () => {
    process.env.PUBLIC_BASE_URL = 'https://auth.example.com/';
    expect(avatarImageBaseUrl()).toBe('https://auth.example.com');

    // Unset in dev/test: an empty base yields relative URLs rather than an error or a bogus
    // HOST:PORT origin.
    Reflect.deleteProperty(process.env, 'PUBLIC_BASE_URL');
    expect(avatarImageBaseUrl()).toBe('');
  });
});
