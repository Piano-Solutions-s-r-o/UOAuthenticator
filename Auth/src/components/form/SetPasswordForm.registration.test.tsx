// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('../../utils/api.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../utils/api.js')>(), postJson: mocks.post,
}));
import { PopupProvider } from '../../hooks/use-popup.js';
import { I18nProvider } from '../../i18n/I18nProvider.js';
import { ThemeProvider } from '../../theme/ThemeProvider.js';
import { SetPasswordForm } from './SetPasswordForm.js';

const challenge = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
const search = `?config_url=https%3A%2F%2Fclient.example.com%2Fauth-config&code_challenge=${challenge}&code_challenge_method=S256`;
const config = {
  language_config: 'en',
  ui_theme: {
    colors: { bg: '#f8fafc', surface: '#ffffff', text: '#0f172a', muted: '#475569', primary: '#2563eb', primary_text: '#ffffff', border: '#e2e8f0', danger: '#dc2626', danger_text: '#ffffff' },
    radii: { card: '16px', button: '12px', input: '12px' }, density: 'comfortable',
    typography: { font_family: 'sans', base_text_size: 'md' },
    button: { style: 'solid' }, card: { style: 'bordered' }, logo: { url: '', alt: 'Logo' },
  },
};

async function mount(host: HTMLElement) {
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <ThemeProvider config={config} configUrl="">
        <I18nProvider config={config} configUrl="">
          <PopupProvider configUrl="https://client.example.com/auth-config" config={config} initialSearch={search}
            initialView="set-password" registrationHandoff={{ email: 'person@example.com' }}>
            <SetPasswordForm />
          </PopupProvider>
        </I18nProvider>
      </ThemeProvider>,
    );
  });
  return root;
}

function type(input: HTMLInputElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function submit(host: HTMLElement) {
  const [password, confirm] = host.querySelectorAll('input');
  await act(async () => {
    type(password, 'a-strong-password-123');
    type(confirm, 'a-strong-password-123');
  });
  await act(async () => {
    host.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.post.mockReset();
});
afterEach(() => { document.body.innerHTML = ''; });

it('posts only the password: the browser that opened the link never holds a token', async () => {
  mocks.post.mockResolvedValue({ ok: false, status: 400, error: 'Request failed', code: 'REGISTRATION_UNAVAILABLE' });
  const host = document.createElement('div'); document.body.appendChild(host);
  const root = await mount(host);
  await submit(host);
  expect(mocks.post).toHaveBeenCalledExactlyOnceWith('/auth/verify-email', { password: 'a-strong-password-123' }, {
    config_url: 'https://client.example.com/auth-config', code_challenge: challenge, code_challenge_method: 'S256',
  });
  act(() => root.unmount());
});

it('shows the invalid-link message when another browser finished first', async () => {
  mocks.post.mockResolvedValue({ ok: false, status: 400, error: 'Request failed', code: 'REGISTRATION_UNAVAILABLE' });
  const host = document.createElement('div'); document.body.appendChild(host);
  const root = await mount(host);
  await submit(host);
  expect(host.textContent).toContain('This link is invalid');
  act(() => root.unmount());
});
