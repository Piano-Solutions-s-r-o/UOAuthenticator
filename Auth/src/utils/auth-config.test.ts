import { describe, expect, it } from 'vitest';

import { isRegistrationCodeEnabled } from './auth-config.js';

// HUGO-2261: the registration code flow ships off; only an explicit `true` in the signed config's
// login_flow turns it on.
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
  ])('is off for %j', (config) => {
    expect(isRegistrationCodeEnabled(config)).toBe(false);
  });

  it('is on only for registration_code_enabled: true inside login_flow', () => {
    expect(isRegistrationCodeEnabled({ login_flow: { registration_code_enabled: true } })).toBe(true);
  });
});
