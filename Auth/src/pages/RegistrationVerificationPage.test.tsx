// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../hooks/use-registration-status.js', () => ({ useRegistrationStatus: () => {} }));
import { PopupProvider, usePopup } from '../hooks/use-popup.js';
import { I18nProvider } from '../i18n/I18nProvider.js';
import { ThemeProvider } from '../theme/ThemeProvider.js';
import { savePendingRegistration, registrationStorageKey } from '../utils/pending-registration.js';
import { RegistrationVerificationPage } from './RegistrationVerificationPage.js';

// HUGO-2261: "Back to sign in" must also forget the pending registration, otherwise a refresh
// (which resumes a pending registration from sessionStorage) brings the code screen back.

const search = '?config_url=https%3A%2F%2Fclient.example.com%2Fauth-config&code_challenge=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ&code_challenge_method=S256';
const config = {
  language_config: 'en',
  enabled_auth_methods: ['email_password'],
  login_flow: { registration_code_enabled: true },
  ui_theme: {
    colors: { bg: '#f8fafc', surface: '#ffffff', text: '#0f172a', muted: '#475569', primary: '#2563eb', primary_text: '#ffffff', border: '#e2e8f0', danger: '#dc2626', danger_text: '#ffffff' },
    radii: { card: '16px', button: '12px', input: '12px' }, density: 'comfortable',
    typography: { font_family: 'sans', base_text_size: 'md' },
    button: { style: 'solid' }, card: { style: 'bordered' }, logo: { url: '', alt: 'Logo' },
  },
};
const key = registrationStorageKey('', search);

// Mirrors PopupContainer: the verification screen only while that is the current view.
function Screen(): React.JSX.Element {
  const { view } = usePopup();
  return view === 'registration-verification' ? <RegistrationVerificationPage /> : <p data-testid="view">{view}</p>;
}

async function mount(initialSearch = search): Promise<{ host: HTMLElement; unmount: () => void }> {
  const host = document.createElement('div'); document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <ThemeProvider config={config} configUrl="">
        <I18nProvider config={config} configUrl="">
          <PopupProvider configUrl="" config={config} initialSearch={initialSearch}><Screen /></PopupProvider>
        </I18nProvider>
      </ThemeProvider>,
    );
  });
  return { host, unmount: () => { act(() => root.unmount()); host.remove(); } };
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  sessionStorage.clear();
  savePendingRegistration(key, { id: '9466e365-206c-49cb-a8d5-aa1342bdd613', email: 'person@example.com' });
});
afterEach(() => { sessionStorage.clear(); });

it('resumes a pending registration after a refresh, and forgets it once the person goes back to sign in', async () => {
  const first = await mount();
  expect(first.host.textContent).toContain('person@example.com');
  const back = [...first.host.querySelectorAll('button')].find((b) => b.textContent === 'Back to sign in');
  if (!back) throw new Error('Back to sign in is missing on the verification screen');
  await act(async () => { back.click(); });
  expect(first.host.querySelector('[data-testid="view"]')?.textContent).toBe('login');
  expect(sessionStorage.getItem(key)).toBeNull();
  first.unmount();

  // A refresh (a fresh mount over the same sessionStorage) now opens sign-in.
  const second = await mount();
  expect(second.host.querySelector('[data-testid="view"]')?.textContent).toBe('login');
  expect(second.host.textContent).not.toContain('person@example.com');
  second.unmount();
});

// Hugo's sign-up path carries prompt=create, so its refresh opens the sign-up form. What matters
// is that the code screen stays gone there too.
it('does not bring the code screen back on the prompt=create entry either', async () => {
  const createSearch = `${search}&prompt=create`;
  savePendingRegistration(registrationStorageKey('', createSearch), { id: '9466e365-206c-49cb-a8d5-aa1342bdd613', email: 'person@example.com' });
  const first = await mount(createSearch);
  const back = [...first.host.querySelectorAll('button')].find((b) => b.textContent === 'Back to sign in');
  if (!back) throw new Error('Back to sign in is missing on the verification screen');
  await act(async () => { back.click(); });
  expect(first.host.querySelector('[data-testid="view"]')?.textContent).toBe('login');
  first.unmount();

  const second = await mount(createSearch);
  expect(second.host.querySelector('[data-testid="view"]')?.textContent).toBe('register');
  expect(second.host.textContent).not.toContain('person@example.com');
  second.unmount();
});

it('still resumes after a refresh when the person did not leave', async () => {
  (await mount()).unmount();
  const refreshed = await mount();
  expect(refreshed.host.textContent).toContain('person@example.com');
  refreshed.unmount();
});
