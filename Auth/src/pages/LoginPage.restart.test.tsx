// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SetPasswordForm } from '../components/form/SetPasswordForm.js';
import { LoginPage } from './LoginPage.js';

// HUGO-1961: a login view without usable PKCE can never authenticate (POST /auth/login
// answers INVALID_PKCE_CHALLENGE), so a client that signed `login_restart_url` gets sent
// back to start a fresh sign-in instead.
const RESTART_URL = 'https://app.example.com/login?start=1';
const mocks = vi.hoisted(() => ({ popup: {} as Record<string, unknown>, post: vi.fn(), redirect: vi.fn(), view: vi.fn() }));
vi.mock('../hooks/use-popup.js', () => ({ usePopup: () => mocks.popup }));
vi.mock('../hooks/use-theme.js', () => ({ useTheme: () => ({ classNames: {}, theme: { button: {} } }) }));
vi.mock('../i18n/use-translation.js', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../utils/api.js', () => ({ postJson: (...args: unknown[]) => mocks.post(...args) }));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  mocks.popup = {
    config: { enabled_auth_methods: ['email_password'], login_restart_url: RESTART_URL },
    configUrl: 'https://api.example.com/config',
    redirectTo: mocks.redirect,
    setView: mocks.view,
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
function button(): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll('button')).find((node) => node.textContent === 'nav.backToLogin');
  if (!found) throw new Error('Missing recovery button');
  return found;
}
describe('password reset client restart', () => {
  it('returns to client initiation after saving the password, without logging in with a missing challenge', async () => {
    Object.assign(mocks.popup, { emailToken: 'synthetic-reset', emailTokenType: 'PASSWORD_RESET' });
    mocks.post.mockResolvedValue({ ok: true, data: {} });
    await act(async () => root.render(<SetPasswordForm />));
    for (const input of container.querySelectorAll<HTMLInputElement>('input[type="password"]')) {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        if (!setter) throw new Error('Missing input setter');
        setter.call(input, 'SyntheticPassword123');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }
    const form = container.querySelector('form');
    if (!form) throw new Error('Missing password form');
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(mocks.post).toHaveBeenCalledWith(
      '/auth/reset-password',
      { token: 'synthetic-reset', password: 'SyntheticPassword123' },
      { config_url: 'https://api.example.com/config' },
    );
    await act(async () => button().click());
    expect(mocks.redirect).toHaveBeenCalledWith(RESTART_URL);
    expect(mocks.view).not.toHaveBeenCalled();
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });
  it('shows recovery, not an unusable login form, when the login view has no PKCE (stale reset or registration link)', async () => {
    await act(async () => root.render(<LoginPage />));
    expect(container.querySelector('form')).toBeNull();
    expect(container.textContent).toContain('auth.login.restartRequired');
    await act(async () => button().click());
    expect(mocks.redirect).toHaveBeenCalledWith(RESTART_URL);
  });
  it('treats a challenge without S256 as unusable', async () => {
    Object.assign(mocks.popup, { codeChallenge: 'a'.repeat(43), codeChallengeMethod: 'plain' });
    await act(async () => root.render(<LoginPage />));
    expect(container.querySelector('form')).toBeNull();
    expect(container.textContent).toContain('auth.login.restartRequired');
  });
  it('preserves the normal sign-in form when fresh PKCE is present', async () => {
    Object.assign(mocks.popup, { codeChallenge: 'a'.repeat(43), codeChallengeMethod: 'S256' });
    await act(async () => root.render(<LoginPage />));
    expect(container.querySelector('form')).not.toBeNull();
    expect(container.textContent).not.toContain('auth.login.restartRequired');
  });
  it('preserves clients that have not opted into restart', async () => {
    mocks.popup.config = { enabled_auth_methods: ['email_password'] };
    await act(async () => root.render(<LoginPage />));
    expect(container.querySelector('form')).not.toBeNull();
  });
});
