import { describe, expect, it } from 'vitest';

import { sanitizeConfigJwtForHandshakeLog } from '../../src/middleware/config-verifier.js';

function jwtWith(payload: Record<string, unknown>): string {
  const part = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'RS256' })}.${part(payload)}.signature`;
}

describe('sanitizeConfigJwtForHandshakeLog', () => {
  it('keeps the login_flow switches readable and still redacts keys it does not know', () => {
    const { payload } = sanitizeConfigJwtForHandshakeLog(
      jwtWith({
        login_flow: {
          email_code_enabled: false,
          registration_code_enabled: true,
          workspace_selection: 'off',
          unexpected: 'value',
        },
      }),
    );

    expect(payload).toEqual({
      login_flow: {
        email_code_enabled: false,
        registration_code_enabled: true,
        workspace_selection: 'off',
        unexpected: '[redacted_unrecognized]',
      },
    });
  });

  it('keeps the registration restart URL readable without its query, like the login restart URL', () => {
    const { payload } = sanitizeConfigJwtForHandshakeLog(
      jwtWith({ login_restart_url: 'https://a.example/login?start=1', registration_restart_url: 'https://a.example/login?signup=1' }),
    );

    expect(payload).toEqual({
      login_restart_url: 'https://a.example/login',
      registration_restart_url: 'https://a.example/login',
    });
  });
});
