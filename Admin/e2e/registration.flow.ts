import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import { registrationLinkPageCsp, renderRegistrationLinkPage } from '../../API/src/services/registration-link-page.service.js';
import { resolveEmailLocale } from '../../API/src/utils/email-locale.js';
import { buildRegistrationVerificationTemplate } from '../../API/src/services/email.templates.registration.js';
import { buildVerifyEmailSetPasswordTemplate } from '../../API/src/services/email.templates.js';

const id = '9466e365-206c-49cb-a8d5-aa1342bdd613';
// The mailbox page exactly as the API serves it: its own nonce, and its own restrictive policy, so
// the browser blocks the page's script if the nonce and the policy ever disagree.
const mailboxPage = (locale?: 'en' | 'cs') => ({
  contentType: 'text/html',
  headers: { 'content-security-policy': registrationLinkPageCsp('synthetic-nonce') },
  body: renderRegistrationLinkPage('synthetic-nonce', locale),
});
const search = '?config_url=https%3A%2F%2Fproduct.example%2Fconfig&code_challenge=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ&code_challenge_method=S256';
const loginRestartUrl = 'https://product.example/login?start=1';
const registrationRestartUrl = 'https://product.example/login?start=1&signup=1';
// `secondary` styles "create account" (and so "back to sign in", HUGO-1858) as a filled button.
// `registrationCode: false` leaves `login_flow` out, as every product's config is until it opts in.
// `handoff` is what the API bootstraps for a browser that opened a registration link.
type Variant = { language: 'en' | 'cs'; secondary: boolean; registrationCode: boolean; handoff: { email: string } };
async function configure(page: Page, variant: Partial<Variant> = {}) {
  await page.addInitScript(({ language = 'en', secondary = false, registrationCode = true, handoff, loginRestartUrl, registrationRestartUrl }) => {
    Object.assign(window, {
      ...(handoff ? { __UOA_REGISTRATION_HANDOFF__: handoff } : {}),
      __UOA_CLIENT_CONFIG__: {
        app_name: 'Example product', enabled_auth_methods: ['email_password'], language_config: language,
        login_restart_url: loginRestartUrl,
        ...(registrationCode ? { login_flow: { registration_code_enabled: true }, registration_restart_url: registrationRestartUrl } : {}),
        ui_theme: {
          colors: { bg: '#f8fafc', surface: '#ffffff', text: '#0f172a', muted: '#475569', primary: '#2563eb', primary_text: '#ffffff', ...(secondary ? { secondary: '#e2ddd5' } : {}), border: '#e2e8f0', danger: '#dc2626', danger_text: '#ffffff' },
          radii: { card: '16px', input: '8px', button: '8px' }, density: 'comfortable',
          typography: { font_family: 'sans', base_text_size: 'md' },
          button: { style: 'solid', ...(secondary ? { create_account: 'secondary' } : {}) }, card: { style: 'bordered' }, logo: { url: '', alt: 'Example product' },
        },
      }, __UOA_CONFIG_URL__: 'https://product.example/config',
    });
  }, { ...variant, loginRestartUrl, registrationRestartUrl });
}
const labels = {
  en: { create: 'Create an account', email: 'Email', submit: 'Register', heading: 'Check your email' },
  cs: { create: 'Vytvořit účet', email: 'E-mail', submit: 'Registrovat', heading: 'Zkontroluj e-mail' },
};
// Resolves once the screen after submit shows: the code-entry heading, or `sentText` for the original flow.
async function start(page: Page, language: 'en' | 'cs' = 'en', sentText?: string) {
  const text = labels[language];
  await page.goto(`/${search}`);
  await page.getByRole('button', { name: text.create, exact: true }).click();
  await page.getByLabel(text.email, { exact: true }).fill('person@example.com');
  await page.getByRole('button', { name: text.submit, exact: true }).click();
  if (sentText) await expect(page.getByText(sentText, { exact: true })).toBeVisible();
  else await expect(page.getByRole('heading', { name: text.heading })).toBeVisible();
}
async function backend(page: Page) {
  let status = 'pending';
  let socket: WebSocketRoute | undefined;
  let calls = 0;
  let starts = 0;
  let continues = 0;
  let codeGate: Promise<void> | undefined;
  let continueGate: Promise<void> | undefined;
  let continueAnswer: { status: number; json: object } = { status: 200, json: { ok: true, redirect_to: 'about:blank#signed-in' } };
  let resendGate: Promise<void> | undefined;
  let resendFailure = false;
  await page.routeWebSocket('**/auth/registration/events?**', ws => { socket = ws; });
  await page.route('**/auth/registration/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/start')) {
      starts++;
      if (starts > 1 && resendGate) await resendGate;
      if (starts > 1 && resendFailure) return route.fulfill({ status: 500, json: { error: 'Request failed' } });
      expect(route.request().postDataJSON()).toEqual({ email: 'person@example.com', ...(starts > 1 ? { previous_id: id } : {}) });
      return route.fulfill({ headers: { 'set-cookie': `uoa_registration_${id}=synthetic-browser-credential; HttpOnly; SameSite=Lax; Path=/auth` },
        json: { registration_id: id, message: 'We sent instructions to your email' } });
    }
    if (url.pathname.endsWith('/continue')) {
      continues++;
      expect(route.request().postDataJSON()).toEqual({ id });
      if (continueGate) await continueGate;
      return route.fulfill(continueAnswer);
    }
    if (url.pathname.endsWith('/code')) {
      calls++;
      expect(route.request().postDataJSON().id).toBe(id);
      if (route.request().postDataJSON().code !== 'AB3K7M') return route.fulfill({ status: 400, json: { error: 'Request failed' } });
      if (codeGate) await codeGate;
      status = 'authorized';
    }
    return route.fulfill({ json: status === 'authorized'
      ? { status, token: 'registration.synthetic-proof', token_type: 'VERIFY_EMAIL_SET_PASSWORD' } : { status } });
  });
  return {
    notify: async (next: string) => {
      status = next; await expect.poll(() => Boolean(socket)).toBe(true);
      if (!socket) throw new Error('Registration socket was not established');
      socket.send(JSON.stringify({ type: 'registration.changed' }));
    },
    setStatus: (next: string) => { status = next; },
    calls: () => calls,
    starts: () => starts,
    continues: () => continues,
    answerContinue: (answer: { status: number; json: object }) => { continueAnswer = answer; },
    pauseContinue: () => { let release = () => {}; continueGate = new Promise<void>(resolve => { release = resolve; }); return release; },
    pauseCode: () => { let release = () => {}; codeGate = new Promise<void>(resolve => { release = resolve; }); return release; },
    pauseResend: () => { let release = () => {}; resendGate = new Promise<void>(resolve => { release = resolve; }); return release; },
    failResend: () => { resendFailure = true; },
  };
}

test('registration screen, keyboard entry, failed code and full paste recovery', async ({ page }, info) => {
  await configure(page); const server = await backend(page); await start(page);
  const fields = page.getByRole('textbox', { name: /Or enter the code from the email \d \/ 6/ });
  await expect(fields).toHaveCount(6);
  await expect(page.getByText(/person@example.com/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('after-registration.png'), fullPage: true });
  await fields.nth(0).pressSequentially('AAAAAA');
  await expect(page.getByRole('alert')).toContainText('We could not verify');
  await expect(fields.nth(0)).toHaveValue('A');
  await page.screenshot({ path: info.outputPath('invalid-code.png'), fullPage: true });
  await fields.nth(3).evaluate(element => {
    const data = new DataTransfer(); data.setData('text/plain', 'ab3k7m');
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(page.getByRole('heading', { name: 'Create your password' })).toBeVisible();
  expect(server.calls()).toBe(2);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Create your password' })).toBeVisible();
});

test('the password set elsewhere takes the original window in by itself over websocket', async ({ page }, info) => {
  await configure(page); const server = await backend(page);
  await page.clock.install(); // No polling interval runs: going in must follow the socket hint.
  await start(page);
  const release = server.pauseContinue();
  await server.notify('complete');
  await expect(page.getByRole('heading', { name: 'Done. Signing you in to Hugo…' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('original-window-continuing.png'), fullPage: true });
  release();
  await expect(page).toHaveURL('about:blank#signed-in');
  expect(server.continues()).toBe(1);
  expect(server.calls()).toBe(0);
});

test('the original window offers sign-in when it can no longer go in by itself', async ({ page }, info) => {
  await configure(page); const server = await backend(page); await start(page);
  await page.route(`${loginRestartUrl}`, route => route.fulfill({ contentType: 'text/html', body: '<h1>Product sign-in</h1>' }));
  server.answerContinue({ status: 400, json: { error: 'Request failed', code: 'REGISTRATION_UNAVAILABLE' } });
  await server.notify('complete');
  await expect(page.getByRole('heading', { name: 'Registration is complete.' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('original-window-finished.png'), fullPage: true });
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Product sign-in' })).toBeVisible();
});

test('the original window shows the normal 2FA step when its continuation needs one', async ({ page }) => {
  await configure(page); const server = await backend(page); await start(page);
  server.answerContinue({ status: 200, json: { ok: true, twofa_required: true, twofa_token: 'synthetic-challenge' } });
  await server.notify('complete');
  await expect(page.getByRole('heading', { name: 'Verify two-factor code' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Registration is complete.' })).toHaveCount(0);
});

test('a browser that opened the link sets the password there and goes straight to the product', async ({ page }, info) => {
  await configure(page, { handoff: { email: 'person@example.com' } });
  let posted: unknown;
  await page.route('**/auth/verify-email**', route => {
    posted = route.request().postDataJSON();
    return route.fulfill({ json: { ok: true, redirect_to: 'about:blank#signed-in' } });
  });
  await page.goto(`/${search}&prompt=create`);
  await expect(page.getByRole('heading', { name: 'Create your password' })).toBeVisible();
  await expect(page.getByText("You're registering an account for")).toContainText('person@example.com');
  await page.screenshot({ path: info.outputPath('clicked-browser-password.png'), fullPage: true });
  await page.getByLabel('New password', { exact: true }).fill('a-strong-password-123');
  await page.getByLabel('Confirm password', { exact: true }).fill('a-strong-password-123');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page).toHaveURL('about:blank#signed-in');
  expect(posted).toEqual({ email: 'person@example.com', password: 'a-strong-password-123' });
});

test('the browser that loses to another one gets a plain failure and no account', async ({ page }) => {
  await configure(page, { handoff: { email: 'person@example.com' } });
  await page.route('**/auth/verify-email**', route => route.fulfill({ status: 400, json: { error: 'Request failed', code: 'REGISTRATION_UNAVAILABLE' } }));
  await page.goto(`/${search}`);
  await page.getByLabel('New password', { exact: true }).fill('a-strong-password-123');
  await page.getByLabel('Confirm password', { exact: true }).fill('a-strong-password-123');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByText('This link is invalid or has expired')).toBeVisible();
});

test('the code in the original window leads to the same password screen with the address', async ({ page }) => {
  await configure(page); const server = await backend(page); await start(page);
  const fields = page.getByRole('textbox', { name: /Or enter the code from the email \d \/ 6/ });
  await fields.nth(0).evaluate(element => {
    const data = new DataTransfer(); data.setData('text/plain', 'AB3K7M');
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(page.getByRole('heading', { name: 'Create your password' })).toBeVisible();
  await expect(page.getByText("You're registering an account for")).toContainText('person@example.com');
  await expect(page.getByRole('button', { name: 'Create account', exact: true })).toBeVisible();
  expect(server.calls()).toBe(1);
});

test('Change email forgets the registration and opens an empty form', async ({ page }) => {
  await configure(page); await backend(page); await start(page);
  await page.getByRole('button', { name: 'Change email', exact: true }).click();
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue('');
  await expect(page.getByRole('heading', { name: 'Check your email' })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toHaveCount(0);
});

test('requesting another email preserves the address and clears only the old code', async ({ page }, info) => {
  await configure(page); const server = await backend(page); await start(page);
  const fields = page.getByRole('textbox', { name: /Or enter the code from the email \d \/ 6/ });
  await fields.nth(0).fill('A');
  const release = server.pauseResend();
  await page.getByRole('button', { name: 'Send again', exact: true }).click();
  await expect(page.getByRole('button', { name: /Sending/ })).toBeVisible();
  await page.screenshot({ path: info.outputPath('resend-loading.png'), fullPage: true });
  release();
  await expect(fields.nth(0)).toHaveValue('');
  await expect(page.getByText('person@example.com', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText("We've sent a new email.");
  expect(server.starts()).toBe(2);
});

test('a blocked websocket falls back to polling and the window still goes in', async ({ page }) => {
  await configure(page);
  await page.addInitScript(() => { Object.defineProperty(window, 'WebSocket', { value: undefined }); });
  const server = await backend(page);
  await page.clock.install();
  await start(page);
  server.setStatus('complete');
  await page.clock.fastForward(11000);
  await expect(page).toHaveURL('about:blank#signed-in');
  expect(server.continues()).toBe(1);
});

test('code entry shows partial input and verification loading before continuing', async ({ page }, info) => {
  await configure(page); const server = await backend(page); await start(page);
  const fields = page.getByRole('textbox', { name: /Or enter the code from the email \d \/ 6/ });
  await fields.nth(0).pressSequentially('AB3K7');
  await page.screenshot({ path: info.outputPath('partial-code.png'), fullPage: true });
  const release = server.pauseCode();
  await fields.nth(5).fill('M');
  await expect(page.getByRole('status')).toContainText('Verifying');
  await page.screenshot({ path: info.outputPath('code-verifying.png'), fullPage: true });
  release();
  await expect(page.getByRole('heading', { name: 'Create your password' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('code-original-continued.png'), fullPage: true });
});

test('expiry and resend failure preserve a clear recovery screen', async ({ page }, info) => {
  await configure(page); const server = await backend(page); await start(page);
  await server.notify('expired');
  await expect(page.getByRole('textbox', { name: /Or enter the code from the email \d \/ 6/ })).toHaveCount(0);
  await expect(page.getByText(/We've sent a link/)).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('registration-expired.png'), fullPage: true });
  server.failResend();
  await page.getByRole('button', { name: 'Request a new email' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.screenshot({ path: info.outputPath('resend-failed.png'), fullPage: true });
});

// HUGO-2261: what the mailbox page does with each answer of POST /auth/registration/link.
test('the link page opens the product at once, with no button and the secret gone from the address', async ({ page }, info) => {
  let release = () => {};
  const answer = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/auth/registration/link', async route => {
    if (route.request().method() !== 'POST') return route.fulfill(mailboxPage());
    expect(route.request().postDataJSON()).toEqual({ token: 'synthetic-link-secret' });
    await answer;
    return route.fulfill({ json: { status: 'continue', next: registrationRestartUrl } });
  });
  await page.route(registrationRestartUrl, route => route.fulfill({ contentType: 'text/html', body: '<h1>Product start</h1>' }));
  await page.goto('/auth/registration/link#synthetic-link-secret');
  await expect(page.getByRole('heading', { name: 'Opening Hugo…' })).toBeVisible();
  await expect(page).toHaveURL(/\/auth\/registration\/link$/);
  await expect(page.getByRole('button')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('link-opening.png'), fullPage: true });
  release();
  await expect(page.getByRole('heading', { name: 'Product start' })).toBeVisible();
  expect(page.url()).toBe(registrationRestartUrl);
});

test('the link page says a finished registration is finished and offers sign-in', async ({ page }, info) => {
  await page.route('**/auth/registration/link', route => route.request().method() === 'POST'
    ? route.fulfill({ json: { status: 'complete', next: loginRestartUrl } })
    : route.fulfill(mailboxPage()));
  await page.goto('/auth/registration/link#synthetic-link-secret');
  await expect(page.getByRole('heading', { name: 'Registration is complete.' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', loginRestartUrl);
  await expect(page.getByRole('link', { name: 'Sign in' })).toHaveCSS('background-color', 'rgb(255, 223, 44)');
  await page.screenshot({ path: info.outputPath('link-complete.png'), fullPage: true });
});

test('the link page shows no button when a finished registration has nowhere to go', async ({ page }) => {
  await page.route('**/auth/registration/link', route => route.request().method() === 'POST'
    ? route.fulfill({ json: { status: 'complete' } })
    : route.fulfill(mailboxPage()));
  await page.goto('/auth/registration/link#synthetic-link-secret');
  await expect(page.getByRole('heading', { name: 'Registration is complete.' })).toBeVisible();
  await expect(page.getByRole('link')).toHaveCount(0);
});

test('the link page starts an expired registration again', async ({ page }, info) => {
  await page.route('**/auth/registration/link', route => route.request().method() === 'POST'
    ? route.fulfill({ json: { status: 'expired', next: registrationRestartUrl } })
    : route.fulfill(mailboxPage()));
  await page.goto('/auth/registration/link#synthetic-link-secret');
  await expect(page.getByRole('heading', { name: 'This link is no longer valid' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Start registration again' })).toHaveAttribute('href', registrationRestartUrl);
  await page.screenshot({ path: info.outputPath('link-expired.png'), fullPage: true });
});

test('the link page gives up on a rejected or missing secret without a way on', async ({ page }, info) => {
  await page.route('**/auth/registration/link', route => route.request().method() === 'POST'
    ? route.fulfill({ status: 400, json: { error: 'Request failed' } })
    : route.fulfill(mailboxPage()));
  await page.goto('/auth/registration/link#synthetic-unknown-secret');
  await expect(page.getByRole('heading', { name: 'This link is no longer valid' })).toBeVisible();
  await expect(page.getByRole('link')).toHaveCount(0);
  await expect(page.getByRole('button')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('link-rejected.png'), fullPage: true });
  await page.goto('about:blank');
  await page.goto('/auth/registration/link');
  await expect(page.getByRole('heading', { name: 'This link is no longer valid' })).toBeVisible();
  expect(await page.context().cookies()).toHaveLength(0);
});

test('the link page offers a retry only for what a retry can fix, and keeps the secret for it', async ({ page }, info) => {
  let answer: 'abort' | number = 'abort';
  const tokens: unknown[] = [];
  await page.route('**/auth/registration/link', async route => {
    if (route.request().method() !== 'POST') return route.fulfill(mailboxPage());
    tokens.push(route.request().postDataJSON());
    if (answer === 'abort') return route.abort();
    return answer === 200
      ? route.fulfill({ json: { status: 'complete', next: loginRestartUrl } })
      : route.fulfill({ status: answer, json: { error: 'Request failed' } });
  });
  await page.goto('/auth/registration/link#synthetic-link-secret');
  await expect(page.getByRole('heading', { name: 'We could not reach the server.' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('link-unreachable.png'), fullPage: true });
  for (const status of [429, 503]) {
    answer = status;
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('heading', { name: 'We could not reach the server.' })).toBeVisible();
  }
  answer = 200;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('heading', { name: 'Registration is complete.' })).toBeVisible();
  await expect(page.getByRole('button')).toHaveCount(0);
  expect(tokens).toEqual(Array.from({ length: 4 }, () => ({ token: 'synthetic-link-secret' })));
});

test('capture matching base-revision registration state', async ({ page }, info) => {
  test.skip(!process.env.REGISTRATION_BASE_URL, 'Set REGISTRATION_BASE_URL to a server from the base revision for before screenshots');
  await configure(page);
  await page.route('**/auth/register?**', route => route.fulfill({ json: { message: 'We sent instructions to your email' } }));
  await page.goto(`${process.env.REGISTRATION_BASE_URL}/${search}`);
  await page.getByRole('button', { name: 'Create an account', exact: true }).click();
  await page.getByLabel('Email', { exact: true }).fill('person@example.com');
  await page.getByRole('button', { name: 'Register', exact: true }).click();
  await expect(page.getByText('We sent instructions to your email', { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('before-registration.png'), fullPage: true });
});

test('verification email shows the link and a large, spaced alternative code', async ({ page }, info) => {
  const link = 'https://auth.example.com/auth/registration/link#synthetic-link-secret';
  // The previous template is unchanged from the base revision.
  const previousLink = 'https://auth.example.com/auth/email/link?token=synthetic-link-secret&config_url=https%3A%2F%2Fproduct.example%2Fconfig';
  await page.setContent(buildVerifyEmailSetPasswordTemplate({ link: previousLink }).html);
  await page.screenshot({ path: info.outputPath('before-email.png'), fullPage: true });
  await page.setContent(buildRegistrationVerificationTemplate({ email: 'person@example.com', link, code: 'AB3K7M' }).html);
  await expect(page.getByRole('link', { name: 'Continue registration' })).toHaveAttribute('href', link);
  await expect(page.getByText('AB3K7M', { exact: true })).toHaveCSS('font-size', '32px');
  await expect(page.getByText('AB3K7M', { exact: true })).toHaveCSS('font-weight', '700');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('after-email.png'), fullPage: true });
});

test('the Czech waiting screen has the exact copy and only text actions', async ({ page }, info) => {
  await configure(page, { language: 'cs', secondary: true }); await backend(page); await start(page, 'cs');
  await expect(page.getByText(/Na person@example.com jsme poslali odkaz\. Klikni na něj a nastav si heslo\./)).toBeVisible();
  await expect(page.getByRole('textbox', { name: /Nebo zadej kód z e-mailu \d \/ 6/ })).toHaveCount(6);
  await expect(page.getByRole('button', { name: 'Poslat znovu', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Změnit e-mail', exact: true })).toBeVisible();
  await expect(page.getByRole('button')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Změnit e-mail' })).not.toHaveClass(/uoa-color-secondary/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('czech-registration.png'), fullPage: true });
});

test('the Czech password screen in the clicked browser has the exact copy', async ({ page }, info) => {
  await configure(page, { language: 'cs', handoff: { email: 'person@example.com' } });
  await page.goto(`/${search}`);
  await expect(page.getByRole('heading', { name: 'Vytvoř si heslo' })).toBeVisible();
  await expect(page.getByText('Registruješ účet pro')).toContainText('person@example.com');
  await expect(page.getByRole('button', { name: 'Vytvořit účet', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('czech-password.png'), fullPage: true });
});

// The browser context locale is what makes Chromium send `Accept-Language: cs` (extra HTTP headers
// cannot override it).
test.describe('Czech mailbox landing', () => {
test.use({ locale: 'cs' });
test('the Czech link page follows Accept-Language: cs through every outcome', async ({ page }, info) => {
  expect(await page.evaluate(() => navigator.languages[0])).toBe('cs');
  let answer: 'abort' | number | 'complete' | 'expired' = 'abort';
  await page.route('**/auth/registration/link', async route => {
    if (route.request().method() === 'POST') {
      expect(route.request().postDataJSON()).toEqual({ token: 'synthetic-link-secret' });
      if (answer === 'abort') return route.abort();
      if (typeof answer === 'number') return route.fulfill({ status: answer, json: { error: 'Request failed' } });
      return route.fulfill({ json: { status: answer, next: loginRestartUrl } });
    }
    // Same resolution as the API route: the GET request's Accept-Language picks the language.
    const locale = resolveEmailLocale((await route.request().allHeaders())['accept-language']);
    return route.fulfill(mailboxPage(locale));
  });
  const open = async () => { await page.goto('about:blank'); await page.goto('/auth/registration/link#synthetic-link-secret'); };
  await open();
  await expect(page.locator('html')).toHaveAttribute('lang', 'cs');
  await expect(page.getByRole('heading', { name: 'Nepodařilo se spojit se serverem.' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('link-cs-unreachable.png'), fullPage: true });
  answer = 503;
  await page.getByRole('button', { name: 'Zkusit znovu', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Nepodařilo se spojit se serverem.' })).toBeVisible();
  answer = 'complete';
  await page.getByRole('button', { name: 'Zkusit znovu', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Registrace je hotová.' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Přihlásit se' })).toHaveAttribute('href', loginRestartUrl);
  await page.screenshot({ path: info.outputPath('link-cs-complete.png'), fullPage: true });
  answer = 'expired';
  await open();
  await expect(page.getByRole('heading', { name: 'Odkaz už neplatí' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Začít registraci znovu' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('link-cs-expired.png'), fullPage: true });
  answer = 400;
  await open();
  await expect(page.getByRole('heading', { name: 'Odkaz už neplatí' })).toBeVisible();
  await expect(page.getByRole('link')).toHaveCount(0);
});
});

test('the Czech verification email keeps the button, the link and the large spaced code', async ({ page }, info) => {
  const link = 'https://auth.example.com/auth/registration/link#synthetic-link-secret';
  await page.setContent(buildRegistrationVerificationTemplate({ email: 'person@example.com', link, code: 'AB3K7M', locale: 'cs' }).html);
  await expect(page.locator('html')).toHaveAttribute('lang', 'cs');
  await expect(page.getByRole('heading', { name: 'Dokonči registraci' })).toBeVisible();
  await expect(page.getByText('Registruješ účet pro person@example.com.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Pokračovat v registraci' })).toHaveAttribute('href', link);
  await expect(page.getByText('Nebo zadej v Hugu kód:')).toBeVisible();
  await expect(page.getByText('AB3K7M', { exact: true })).toHaveCSS('font-size', '32px');
  await expect(page.getByText('AB3K7M', { exact: true })).toHaveCSS('font-weight', '700');
  await expect(page.getByText('Odkaz i kód platí 24 hodin.')).toBeVisible();
  await expect(page.getByText('Pokud o registraci nevíš, na nic neklikej a e-mail ignoruj.')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('after-email-cs.png'), fullPage: true });
});

test('without login_flow.registration_code_enabled Create account keeps the original /auth/register flow', async ({ page }, info) => {
  await configure(page, { registrationCode: false });
  const requests: string[] = [];
  await page.route('**/auth/regist*', route => {
    const path = new URL(route.request().url()).pathname;
    requests.push(path);
    if (path !== '/auth/register') return route.fulfill({ status: 500, json: { error: 'Request failed' } });
    expect(route.request().postDataJSON()).toEqual({ email: 'person@example.com' });
    return route.fulfill({ json: { message: 'We sent instructions to your email' } });
  });
  await start(page, 'en', 'We sent instructions to your email');
  await expect(page.getByRole('textbox', { name: /Or enter the code/ })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Check your email' })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('original-flow-sent.png'), fullPage: true });
  // The page-level link is still the way back to sign in, exactly as before.
  await page.getByRole('button', { name: 'Back to sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  expect(requests).toEqual(['/auth/register']);
});
