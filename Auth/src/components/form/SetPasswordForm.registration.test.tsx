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
import { SetPasswordPage } from '../../pages/SetPasswordPage.js';
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
afterEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals(); });

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

// The form forgets the registration just before the browser leaves. The screen must not fall back
// to the password-reset wording in that moment.
it('keeps the registration wording while the original window navigates away', async () => {
  vi.stubGlobal('location', { ...window.location, assign: vi.fn() });
  mocks.post.mockResolvedValue({ ok: true, status: 200, data: { ok: true, redirect_to: 'https://client.example.com/oauth/callback?code=abc' } });
  const host = document.createElement('div'); document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <ThemeProvider config={config} configUrl="">
        <I18nProvider config={config} configUrl="">
          <PopupProvider configUrl="https://client.example.com/auth-config" config={config}
            initialSearch={`${search}&email_token=registration.proof&email_token_type=VERIFY_EMAIL_SET_PASSWORD`}
            initialPendingRegistration={{ id: 'r', email: 'person@example.com' }}>
            <SetPasswordPage />
          </PopupProvider>
        </I18nProvider>
      </ThemeProvider>,
    );
  });
  await submit(host);
  expect(window.location.assign).toHaveBeenCalledOnce();
  expect(host.querySelector('h1')?.textContent).toBe('Create your password');
  expect(host.textContent).toContain('person@example.com');
  act(() => root.unmount());
});

it('tells the browser that came second that the registration is finished', async () => {
  mocks.post.mockResolvedValue({ ok: false, status: 400, error: 'Request failed', code: 'REGISTRATION_COMPLETE' });
  const host = document.createElement('div'); document.body.appendChild(host);
  const root = await mount(host);
  await submit(host);
  expect(host.querySelector('[role="status"]')?.textContent).toBe('Registration is complete.');
  expect(host.querySelector('form')).toBeNull();
  expect([...host.querySelectorAll('button')].some(button => button.textContent === 'Sign in')).toBe(true);
  act(() => root.unmount());
});
