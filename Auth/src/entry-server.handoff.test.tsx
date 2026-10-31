// @vitest-environment happy-dom
import React, { act } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { App } from './App.js';
import { render } from './entry-server.js';

// HUGO-2261: the API renders the password form on the server and bootstraps the same address for the
// client. If the two disagree React throws the page away, and with it what the person already typed.
const search = '?config_url=https%3A%2F%2Fclient.example.com%2Fauth-config&code_challenge=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ&code_challenge_method=S256&prompt=create';
const handoff = { email: 'person@example.com' };
const config = {
  language_config: 'en',
  enabled_auth_methods: ['email_password'],
  login_flow: { registration_code_enabled: true },
  registration_restart_url: 'https://client.example.com/login?start=1&signup=1',
  ui_theme: {
    colors: { bg: '#f8fafc', surface: '#ffffff', text: '#0f172a', muted: '#475569', primary: '#2563eb', primary_text: '#ffffff', border: '#e2e8f0', danger: '#dc2626', danger_text: '#ffffff' },
    radii: { card: '16px', button: '12px', input: '12px' }, density: 'comfortable',
    typography: { font_family: 'sans', base_text_size: 'md' },
    button: { style: 'solid' }, card: { style: 'bordered' }, logo: { url: '', alt: 'Logo' },
  },
};

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  for (const key of ['__UOA_CLIENT_CONFIG__', '__UOA_CONFIG_URL__', '__UOA_REGISTRATION_HANDOFF__']) Reflect.deleteProperty(window, key);
});

it('renders the password form on the server for a handoff, with no token anywhere', async () => {
  const html = await render({ config, configUrl: '', url: `/auth${search}`, registrationHandoff: handoff });
  expect(html).toContain('Create your password');
  expect(html).toContain('<strong>person@example.com</strong>');
  expect(html).not.toContain('email_token');
});

it('stays on the register form on the server without one', async () => {
  const html = await render({ config, configUrl: '', url: `/auth${search}` });
  expect(html).not.toContain('Create your password');
  expect(html).not.toContain('type="password"');
});

it('hydrates that form without a mismatch and enables it', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const html = await render({ config, configUrl: '', url: `/auth${search}`, registrationHandoff: handoff });
  Object.assign(window, { __UOA_CLIENT_CONFIG__: config, __UOA_CONFIG_URL__: '', __UOA_REGISTRATION_HANDOFF__: handoff });
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.appendChild(host);
  const recoverable = vi.fn();
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  let root: ReturnType<typeof hydrateRoot> | undefined;
  await act(async () => {
    root = hydrateRoot(host, <App initialSearch={search} />, { onRecoverableError: recoverable });
  });
  expect(recoverable).not.toHaveBeenCalled();
  expect(logged).not.toHaveBeenCalled();
  expect(host.querySelector('fieldset')?.disabled).toBe(false);
  expect(host.textContent).toContain('person@example.com');
  act(() => root?.unmount());
});
