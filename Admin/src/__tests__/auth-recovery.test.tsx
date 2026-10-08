// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SetPasswordForm } from '../../../Auth/src/components/form/SetPasswordForm.js';
import { LoginPage } from '../../../Auth/src/pages/LoginPage.js';

const mocks = vi.hoisted(() => ({ popup: {} as Record<string, unknown>, post: vi.fn(), redirect: vi.fn(), view: vi.fn() }));
vi.mock('../../../Auth/src/hooks/use-popup.js', () => ({ usePopup: () => mocks.popup }));
vi.mock('../../../Auth/src/hooks/use-theme.js', () => ({ useTheme: () => ({ classNames: {}, theme: { button: {} } }) }));
vi.mock('../../../Auth/src/i18n/use-translation.js', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../Auth/src/utils/api.js', () => ({ postJson: (...args: unknown[]) => mocks.post(...args) }));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  mocks.popup = {
    config: { enabled_auth_methods: ['email_password'], login_restart_url: 'https://app.example.com/login?start=1' },
    configUrl: 'https://api.example.com/config', emailToken: 'synthetic-reset', emailTokenType: 'PASSWORD_RESET',
    redirectTo: mocks.redirect, setView: mocks.view,
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
function button(): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll('button')).find((node) => node.textContent === 'nav.backToLogin');
  if (!found) throw new Error('Missing recovery button');
  return found;
}
describe('password reset client restart', () => {
  it('returns to client initiation after saving the password, without logging in with a missing challenge', async () => {
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
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(mocks.post).toHaveBeenCalledWith('/auth/reset-password', { token: 'synthetic-reset', password: 'SyntheticPassword123' }, { config_url: 'https://api.example.com/config' });
    await act(async () => button().click());
    expect(mocks.redirect).toHaveBeenCalledWith('https://app.example.com/login?start=1');
    expect(mocks.view).not.toHaveBeenCalled();
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });
  it('shows recovery, not an unusable login form, for the context emitted by a stale reset link', async () => {
    await act(async () => root.render(<LoginPage />));
    expect(container.querySelector('form')).toBeNull();
    expect(container.textContent).toContain('auth.login.restartRequired');
    await act(async () => button().click());
    expect(mocks.redirect).toHaveBeenCalledWith('https://app.example.com/login?start=1');
  });
  it('preserves the normal sign-in form when fresh PKCE is present', async () => {
    mocks.popup.codeChallenge = 'a'.repeat(43);
    mocks.popup.codeChallengeMethod = 'S256';
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
