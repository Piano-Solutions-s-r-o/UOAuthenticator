// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LoginForm } from './LoginForm.js';
import { PopupProvider, usePopup } from '../../hooks/use-popup.js';
import { I18nProvider } from '../../i18n/I18nProvider.js';
import { cs } from '../../i18n/translations/cs.js';
import { en } from '../../i18n/translations/en.js';
import { setRequestLanguage } from '../../utils/api.js';
import { ThemeProvider } from '../../theme/ThemeProvider.js';

// HUGO-2288: a failed sign-in used to say "Invalid email or password." for every failure, including
// the 429 the rate limiter answers with — so a person locked out for five tries was told their
// password was wrong and kept retrying. The form now tells a pause (429) apart from a mismatch
// (anything else), and both texts point to "create account" / "forgot password". The server still
// answers a wrong password and an unknown address identically (no account enumeration), and the
// limiter counts the address typed, not an account, so the 429 reveals nothing either.

const TEXTS = { cs, en } as const;

const TEST_CONFIG = (language: string) => ({
  ui_theme: {
    colors: {
      bg: '#f8fafc',
      surface: '#ffffff',
      text: '#0f172a',
      muted: '#475569',
      primary: '#2563eb',
      primary_text: '#ffffff',
      border: '#e2e8f0',
      danger: '#dc2626',
      danger_text: '#ffffff',
    },
    radii: { card: '16px', button: '12px', input: '12px' },
    density: 'comfortable',
    typography: { font_family: 'sans', base_text_size: 'md' },
    button: { style: 'solid' },
    card: { style: 'bordered' },
    logo: { url: '', alt: 'Logo' },
  },
  language_config: language,
});

function ViewProbe(): React.JSX.Element {
  return <output data-testid="view">{usePopup().view}</output>;
}

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('LoginForm failure message', () => {
  let container: HTMLDivElement;
  let root: Root;
  const fetchMock = vi.fn();

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal('fetch', fetchMock);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    setRequestLanguage(null);
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  async function renderForm(language: 'cs' | 'en'): Promise<void> {
    const config = TEST_CONFIG(language);
    await act(async () => {
      root.render(
        <ThemeProvider config={config} configUrl="">
          <I18nProvider config={config} configUrl="">
            <PopupProvider
              configUrl=""
              config={config}
              initialSearch="?config_url=https%3A%2F%2Fclient.example.com%2Fauth-config"
            >
              <LoginForm />
              <ViewProbe />
            </PopupProvider>
          </I18nProvider>
        </ThemeProvider>,
      );
    });
  }

  function type(name: 'email' | 'password', value: string): void {
    const input = container.querySelector<HTMLInputElement>(`input[name="${name}"]`);
    if (!input) throw new Error(`no ${name} input`);
    // React tracks the value itself; set it through the prototype setter so onChange fires.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  async function signIn(): Promise<void> {
    await act(async () => {
      type('email', 'someone@example.com');
      type('password', 'not-the-password');
    });
    await act(async () => {
      container
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      // postJson awaits fetch, then response.json(); let both settle before React flushes.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  /** The red message under the password field (the form's only paragraph). */
  function shownError(): string | null {
    return container.querySelector('form p')?.textContent ?? null;
  }

  describe.each(['cs', 'en'] as const)('in %s', (language) => {
    const text = TEXTS[language];

    it.each([401, 400, 500])('answers a %i with the "does not match" text', async (status) => {
      fetchMock.mockResolvedValue(reply(status, { error: 'Request failed' }));
      await renderForm(language);
      await signIn();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(shownError()).toBe(text['form.login.error']);
    });

    it('answers a lost connection with the "does not match" text', async () => {
      fetchMock.mockRejectedValue(new TypeError('network down'));
      await renderForm(language);
      await signIn();

      expect(shownError()).toBe(text['form.login.error']);
    });

    it('answers the rate limiter (429) with the "paused" text, not the mismatch one', async () => {
      fetchMock.mockResolvedValue(reply(429, { error: 'Request failed' }));
      await renderForm(language);
      await signIn();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(shownError()).toBe(text['form.login.rateLimited']);
      expect(container.textContent).not.toContain(text['form.login.error']);
    });

    it('keeps the "does not match" text for a 200 it cannot act on', async () => {
      fetchMock.mockResolvedValue(reply(200, {}));
      await renderForm(language);
      await signIn();

      expect(shownError()).toBe(text['form.login.error']);
    });

    it('shows no message when the sign-in succeeds', async () => {
      fetchMock.mockResolvedValue(
        reply(200, { login_token: 'bridge', teams: [], pending_invites: [], can_create_org: true }),
      );
      await renderForm(language);
      await signIn();

      expect(shownError()).toBeNull();
      expect(container.querySelector('output')?.textContent).toBe('workspace-chooser');
    });
  });

  it('keeps the two texts apart and each one pointing at a way forward', () => {
    for (const text of [cs, en]) {
      expect(text['form.login.rateLimited']).not.toBe(text['form.login.error']);
    }
    // The failure text names both ways out; the pause text names the password reset.
    expect(cs['form.login.error']).toContain('Vytvoř si ho');
    expect(cs['form.login.error']).toContain('Zapomenuté heslo');
    expect(cs['form.login.rateLimited']).toContain('15 minut');
    expect(cs['form.login.rateLimited']).toContain('Zapomenuté heslo');
    expect(en['form.login.error']).toContain('Create one');
    expect(en['form.login.error']).toContain('Forgot your password');
    expect(en['form.login.rateLimited']).toContain('15 minutes');
    expect(en['form.login.rateLimited']).toContain('Forgot your password');
  });
});
