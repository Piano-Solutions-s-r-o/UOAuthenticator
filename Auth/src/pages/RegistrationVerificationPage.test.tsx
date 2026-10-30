// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  state: { current: undefined as undefined | ((state: { status: string; token?: string; token_type?: string }) => void) },
}));
vi.mock('../hooks/use-registration-status.js', () => ({
  useRegistrationStatus: (params: { onState: NonNullable<typeof mocks.state.current> }) => { mocks.state.current = params.onState; },
}));
vi.mock('../utils/api.js', async importOriginal => ({
  ...await importOriginal<typeof import('../utils/api.js')>(), postJson: mocks.post,
}));
import { PopupProvider, usePopup } from '../hooks/use-popup.js';
import { I18nProvider } from '../i18n/I18nProvider.js';
import { ThemeProvider } from '../theme/ThemeProvider.js';
import { savePendingRegistration, registrationStorageKey } from '../utils/pending-registration.js';
import { RegistrationVerificationPage } from './RegistrationVerificationPage.js';

const id = '9466e365-206c-49cb-a8d5-aa1342bdd613';
const search = '?config_url=https%3A%2F%2Fclient.example.com%2Fauth-config&code_challenge=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ&code_challenge_method=S256';
const restartUrl = 'https://client.example.com/login?start=1';
const config = {
  language_config: 'en',
  enabled_auth_methods: ['email_password'],
  login_flow: { registration_code_enabled: true },
  registration_restart_url: `${restartUrl}&signup=1`,
  login_restart_url: restartUrl,
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
  const { view, twoFaToken } = usePopup();
  if (twoFaToken) return <p data-testid="view">two-factor</p>;
  return view === 'registration-verification' ? <RegistrationVerificationPage /> : <p data-testid="view">{view}</p>;
}

async function mount(activeConfig: unknown = config, initialSearch = search) {
  const host = document.createElement('div'); document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <ThemeProvider config={activeConfig} configUrl="">
        <I18nProvider config={activeConfig} configUrl="">
          <PopupProvider configUrl="" config={activeConfig} initialSearch={initialSearch}><Screen /></PopupProvider>
        </I18nProvider>
      </ThemeProvider>,
    );
  });
  return { host, unmount: () => { act(() => root.unmount()); host.remove(); } };
}

const button = (host: HTMLElement, name: string) => {
  const found = [...host.querySelectorAll('button')].find(b => b.textContent === name);
  if (!found) throw new Error(`${name} is missing`);
  return found;
};
const viewOf = (host: HTMLElement) => host.querySelector('[data-testid="view"]')?.textContent;
const deliver = (state: { status: string; token?: string; token_type?: string }) => act(async () => { mocks.state.current?.(state); });

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.post.mockReset();
  sessionStorage.clear();
  savePendingRegistration(key, { id, email: 'person@example.com' });
});
afterEach(() => { sessionStorage.clear(); vi.unstubAllGlobals(); });

it('resumes a pending registration after a refresh when the person did not leave', async () => {
  (await mount()).unmount();
  const refreshed = await mount();
  expect(refreshed.host.textContent).toContain('person@example.com');
  refreshed.unmount();
});

it('offers no way back to sign in: the two text actions are the whole way on', async () => {
  const screen = await mount();
  expect([...screen.host.querySelectorAll('button')].map(b => b.textContent)).toEqual(['Send again', 'Change email']);
  screen.unmount();
});

it('forgets the pending registration on Change email and opens the register form', async () => {
  const first = await mount();
  await act(async () => { button(first.host, 'Change email').click(); });
  expect(viewOf(first.host)).toBe('register');
  expect(sessionStorage.getItem(key)).toBeNull();
  first.unmount();
  const second = await mount();
  expect(viewOf(second.host)).toBe('login');
  expect(second.host.textContent).not.toContain('person@example.com');
  second.unmount();
});

// Hugo's sign-up path carries prompt=create, so its refresh opens the sign-up form. What matters
// is that the code screen stays gone there too.
it('does not bring the waiting screen back on the prompt=create entry either', async () => {
  const createSearch = `${search}&prompt=create`;
  savePendingRegistration(registrationStorageKey('', createSearch), { id, email: 'person@example.com' });
  const first = await mount(config, createSearch);
  await act(async () => { button(first.host, 'Change email').click(); });
  first.unmount();
  const second = await mount(config, createSearch);
  expect(viewOf(second.host)).toBe('register');
  second.unmount();
});

it('resends with the previous id, says so, and waits on the new registration', async () => {
  const next = '11111111-1111-4111-8111-111111111111';
  mocks.post.mockResolvedValue({ ok: true, status: 200, data: { registration_id: next } });
  const screen = await mount();
  expect(screen.host.textContent).not.toContain("We've sent a new email.");
  await act(async () => { button(screen.host, 'Send again').click(); });
  expect(mocks.post).toHaveBeenCalledExactlyOnceWith('/auth/registration/start', { email: 'person@example.com', previous_id: id }, expect.anything());
  expect(screen.host.querySelector('[role="status"]')?.textContent).toBe("We've sent a new email.");
  expect(JSON.parse(sessionStorage.getItem(key) ?? '{}')).toEqual({ id: next, email: 'person@example.com' });
  screen.unmount();
});

it('shows no success line when the resend failed', async () => {
  mocks.post.mockResolvedValue({ ok: false, status: 500, error: 'Request failed', code: null });
  const screen = await mount();
  await act(async () => { button(screen.host, 'Send again').click(); });
  expect(screen.host.querySelector('[role="alert"]')).not.toBeNull();
  expect(screen.host.textContent).not.toContain("We've sent a new email.");
  screen.unmount();
});

it('goes in by itself on complete, through the continue route and never from the status answer', async () => {
  const assign = vi.fn();
  vi.stubGlobal('location', { ...window.location, assign });
  let answer: (value: unknown) => void = () => {};
  mocks.post.mockReturnValue(new Promise(resolve => { answer = resolve; }));
  const screen = await mount();
  await deliver({ status: 'complete' });
  expect(mocks.post).toHaveBeenCalledExactlyOnceWith('/auth/registration/continue', { id }, expect.objectContaining({ code_challenge_method: 'S256' }));
  expect(screen.host.querySelector('h1')?.textContent).toBe('Done. Signing you in to Hugo…');
  await act(async () => { answer({ ok: true, status: 200, data: { ok: true, redirect_to: 'https://client.example.com/oauth/callback?code=abc' } }); });
  expect(assign).toHaveBeenCalledExactlyOnceWith('https://client.example.com/oauth/callback?code=abc');
  expect(screen.host.querySelector('h1')?.textContent).toBe('Done. Signing you in to Hugo…');
  expect(sessionStorage.getItem(key)).toBeNull();
  screen.unmount();
});

it('goes in on complete even while a resend is on its way, because polling stops there', async () => {
  let finishResend: (value: unknown) => void = () => undefined;
  mocks.post.mockImplementation((path: string) => (path === '/auth/registration/start'
    ? new Promise(resolve => { finishResend = resolve; })
    : Promise.resolve({ ok: false, status: 400, error: 'Request failed', code: 'REGISTRATION_UNAVAILABLE' })));
  const screen = await mount();
  await act(async () => { button(screen.host, 'Send again').click(); });
  await deliver({ status: 'complete' });
  expect(mocks.post).toHaveBeenCalledWith('/auth/registration/continue', { id }, expect.anything());
  await act(async () => { finishResend({ ok: true, data: { registration_id: id } }); });
  screen.unmount();
});

it('asks once, even when the state arrives twice', async () => {
  mocks.post.mockResolvedValue({ ok: false, status: 400, error: 'Request failed', code: 'REGISTRATION_UNAVAILABLE' });
  const screen = await mount();
  await deliver({ status: 'complete' });
  await deliver({ status: 'complete' });
  expect(mocks.post).toHaveBeenCalledTimes(1);
  screen.unmount();
});

it('shows the normal 2FA step when the continuation needs one', async () => {
  mocks.post.mockResolvedValue({ ok: true, status: 200, data: { ok: true, twofa_required: true, twofa_token: 'challenge' } });
  const screen = await mount();
  await deliver({ status: 'complete' });
  expect(viewOf(screen.host)).toBe('two-factor');
  screen.unmount();
});

it('falls back to a sign-in that restarts on the product when continue is refused', async () => {
  const assign = vi.fn();
  vi.stubGlobal('location', { ...window.location, assign });
  mocks.post.mockResolvedValue({ ok: false, status: 400, error: 'Request failed', code: 'REGISTRATION_UNAVAILABLE' });
  const screen = await mount();
  await deliver({ status: 'complete' });
  expect(screen.host.querySelector('h1')?.textContent).toBe('Registration is complete.');
  await act(async () => { button(screen.host, 'Sign in').click(); });
  expect(assign).toHaveBeenCalledExactlyOnceWith(restartUrl);
  expect(sessionStorage.getItem(key)).toBeNull();
  screen.unmount();
});

it('falls back to the sign-in view for a product without a restart URL', async () => {
  const { login_restart_url: _dropped, ...noRestart } = config;
  mocks.post.mockResolvedValue({ ok: false, status: 400, error: 'Request failed', code: 'REGISTRATION_UNAVAILABLE' });
  const screen = await mount(noRestart);
  await deliver({ status: 'complete' });
  await act(async () => { button(screen.host, 'Sign in').click(); });
  expect(viewOf(screen.host)).toBe('login');
  screen.unmount();
});

it('still advances to the password on authorized', async () => {
  const screen = await mount();
  await deliver({ status: 'authorized', token: 'registration.proof', token_type: 'VERIFY_EMAIL_SET_PASSWORD' });
  expect(viewOf(screen.host)).toBe('set-password');
  expect(mocks.post).not.toHaveBeenCalled();
  screen.unmount();
});

it('offers a new email and Change email when the registration expired', async () => {
  const screen = await mount();
  await deliver({ status: 'expired' });
  expect([...screen.host.querySelectorAll('button')].map(b => b.textContent)).toEqual(['Request a new email', 'Change email']);
  expect(screen.host.querySelector('input')).toBeNull();
  screen.unmount();
});
