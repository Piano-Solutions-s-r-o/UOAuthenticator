import { describe, expect, it } from 'vitest';

import { isRegistrationCodeEnabled } from './auth-config.js';

// HUGO-2261: the registration code flow ships off; it takes an explicit `true` in the signed config's
// login_flow and the signed registration restart URL.
describe('isRegistrationCodeEnabled', () => {
  it.each([
    [undefined],
    [null],
    ['config'],
    [{}],
    [{ login_flow: null }],
    [{ login_flow: {} }],
    [{ login_flow: { email_code_enabled: true } }],
    [{ login_flow: { registration_code_enabled: false } }],
    [{ login_flow: { registration_code_enabled: 'true' } }],
    [{ registration_code_enabled: true }],
    [{ login_flow: { registration_code_enabled: true } }],
    [{ login_flow: { registration_code_enabled: true }, registration_restart_url: '' }],
    [{ login_flow: { registration_code_enabled: false }, registration_restart_url: 'https://a.example/login' }],
    [{ login_flow: { registration_code_enabled: true }, registration_restart_url: 42 }],
  ])('is off for %j', (config) => {
    expect(isRegistrationCodeEnabled(config)).toBe(false);
  });

  it('is on only for registration_code_enabled: true inside login_flow plus a restart URL', () => {
    expect(isRegistrationCodeEnabled({
      login_flow: { registration_code_enabled: true }, registration_restart_url: 'https://a.example/login?start=1&signup=1',
    })).toBe(true);
  });
});
