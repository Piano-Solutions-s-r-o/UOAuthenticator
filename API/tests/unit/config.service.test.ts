import { describe, expect, it, vi } from 'vitest';
import type { JWTPayload } from 'jose';

import { validateConfigFields } from '../../src/services/config.service.js';
import { fingerprintClientConfig } from '../../src/services/login-session.service.js';
import { setAppLogger } from '../../src/utils/app-logger.js';
import { baseClientConfigPayload } from '../helpers/test-config.js';

function basePayload(): JWTPayload {
  return baseClientConfigPayload();
}

describe('validateConfigFields', () => {
  it('applies defaults for optional fields when missing', () => {
    const cfg = validateConfigFields(basePayload());

    expect(cfg.user_scope).toBe('global');
    expect(cfg['2fa_enabled']).toBe(false);
    expect(cfg.debug_enabled).toBe(false);
    expect(cfg.allow_registration).toBe(true);
    expect(cfg.registration_mode).toBe('password_required');
    expect(cfg.allowed_registration_domains).toBeUndefined();
    expect(cfg.registration_domain_mapping).toBeUndefined();
    expect(cfg.login_flow).toEqual({ email_code_enabled: false, workspace_selection: 'off' });
  });

  it('parses login_flow when provided', () => {
    const cfg = validateConfigFields({
      ...basePayload(),
      login_flow: {
        email_code_enabled: true,
        workspace_selection: 'auto',
      },
    });

    expect(cfg.login_flow).toEqual({ email_code_enabled: true, workspace_selection: 'auto' });
  });

  it('leaves registration_code_enabled absent unless the signed config sets it', () => {
    for (const loginFlow of [undefined, {}, { email_code_enabled: true }]) {
      const cfg = validateConfigFields({ ...basePayload(), ...(loginFlow ? { login_flow: loginFlow } : {}) });
      expect(cfg.login_flow.registration_code_enabled).toBeUndefined();
      expect('registration_code_enabled' in cfg.login_flow).toBe(false);
    }
    const off = validateConfigFields({ ...basePayload(), login_flow: { registration_code_enabled: false } });
    expect(off.login_flow.registration_code_enabled).toBe(false);
    const on = validateConfigFields({ ...basePayload(), login_flow: { registration_code_enabled: true } });
    expect(on.login_flow).toEqual({
      email_code_enabled: false,
      registration_code_enabled: true,
      workspace_selection: 'off',
    });
  });

  it('still accepts and strips an unknown key inside login_flow', () => {
    const cfg = validateConfigFields({
      ...basePayload(),
      login_flow: { registration_code_enabled: true, rollout_percentage: 50 },
    });
    expect(cfg.login_flow).toEqual({
      email_code_enabled: false,
      registration_code_enabled: true,
      workspace_selection: 'off',
    });
    expect(cfg.login_flow).not.toHaveProperty('rollout_percentage');
  });

  it('fingerprints a config without the key exactly as before the flag existed', () => {
    // login_token continuity across a rolling deploy: the parsed shape piano/main produced for the
    // same payload has no registration_code_enabled key, and neither does ours.
    const parsed = validateConfigFields(basePayload());
    const beforeTheFlag = { ...parsed, login_flow: { email_code_enabled: false, workspace_selection: 'off' as const } };
    expect(fingerprintClientConfig(parsed)).toBe(fingerprintClientConfig(beforeTheFlag));
    expect(JSON.stringify(parsed.login_flow)).toBe('{"email_code_enabled":false,"workspace_selection":"off"}');
    // Opting in is a real config change and does change the binding.
    const optedIn = validateConfigFields({ ...basePayload(), login_flow: { registration_code_enabled: true } });
    expect(fingerprintClientConfig(optedIn)).not.toBe(fingerprintClientConfig(parsed));
  });

  it('parses optional fields when provided', () => {
    const cfg = validateConfigFields({
      ...basePayload(),
      user_scope: 'per_domain',
      '2fa_enabled': true,
      debug_enabled: true,
      enabled_auth_methods: ['email_password', 'google', 'github'],
      allow_registration: false,
      registration_mode: 'password_required',
      allowed_registration_domains: ['  EXAMPLE.COM ', 'subsidiary.co.uk'],
      registration_domain_mapping: [
        {
          email_domain: '  EXAMPLE.COM  ',
          org_id: ' org-1 ',
          team_id: ' team-1 ',
        },
      ],
      language: '  es  ',
    });

    expect(cfg.user_scope).toBe('per_domain');
    expect(cfg['2fa_enabled']).toBe(true);
    expect(cfg.debug_enabled).toBe(true);
    expect(cfg.allow_registration).toBe(false);
    expect(cfg.registration_mode).toBe('password_required');
    expect(cfg.allowed_registration_domains).toEqual(['example.com', 'subsidiary.co.uk']);
    expect(cfg.registration_domain_mapping).toEqual([
      {
        email_domain: 'example.com',
        org_id: 'org-1',
        team_id: 'team-1',
      },
    ]);
    expect(cfg.enabled_auth_methods).toEqual(['email_password', 'google', 'github']);
    expect(cfg.language).toBe('es');
  });

  it('rejects passwordless mode when registration is disabled', () => {
    expect(() =>
      validateConfigFields({
        ...basePayload(),
        allow_registration: false,
        registration_mode: 'passwordless',
      }),
    ).toThrow();
  });

  it('rejects empty allowed_registration_domains arrays', () => {
    expect(() =>
      validateConfigFields({
        ...basePayload(),
        allowed_registration_domains: [],
      }),
    ).toThrow();
  });

  it('rejects duplicate allowed_registration_domains values', () => {
    expect(() =>
      validateConfigFields({
        ...basePayload(),
        allowed_registration_domains: ['example.com', 'example.com'],
      }),
    ).toThrow();
  });

  it('rejects duplicate registration_domain_mapping email domains', () => {
    expect(() =>
      validateConfigFields({
        ...basePayload(),
        registration_domain_mapping: [
          { email_domain: 'example.com', org_id: 'org-1' },
          { email_domain: 'EXAMPLE.COM', org_id: 'org-2' },
        ],
      }),
    ).toThrow();
  });

  it('warns when registration_domain_mapping contains domains outside allowed_registration_domains', () => {
    const warnSpy = vi.fn();
    setAppLogger({ warn: warnSpy } as never);

    const cfg = validateConfigFields({
      ...basePayload(),
      allowed_registration_domains: ['company.com'],
      registration_domain_mapping: [
        { email_domain: 'company.com', org_id: 'org-1' },
        { email_domain: 'gmail.com', org_id: 'org-2' },
      ],
    });

    expect(cfg.registration_domain_mapping).toHaveLength(2);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][1]).toBe(
      'registration_domain_mapping contains domains not in allowed_registration_domains',
    );
  });

  it('rejects invalid user_scope values', () => {
    expect(() =>
      validateConfigFields({
        ...basePayload(),
        user_scope: 'nope',
      } as unknown as JWTPayload),
    ).toThrow();
  });

  it('rejects invalid redirect_urls entries', () => {
    expect(() =>
      validateConfigFields({
        ...basePayload(),
        redirect_urls: ['javascript:alert(1)'],
      }),
    ).toThrow();

    expect(() =>
      validateConfigFields({
        ...basePayload(),
        redirect_urls: ['/relative/path'],
      }),
    ).toThrow();
  });

  it('trims redirect_urls entries', () => {
    const cfg = validateConfigFields({
      ...basePayload(),
      redirect_urls: ['  https://client.example.com/oauth/callback  '],
    });

    expect(cfg.redirect_urls).toEqual(['https://client.example.com/oauth/callback']);
  });
});
