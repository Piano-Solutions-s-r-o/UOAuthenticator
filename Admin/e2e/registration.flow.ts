import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { registrationLinkPageCsp, renderRegistrationLinkPage } from '../../API/src/services/registration-link-page.service.js';
import { resolveEmailLocale } from '../../API/src/utils/email-locale.js';
import { buildRegistrationVerificationTemplate } from '../../API/src/services/email.templates.registration.js';
import { buildVerifyEmailSetPasswordTemplate } from '../../API/src/services/email.templates.js';

const id = '9466e365-206c-49cb-a8d5-aa1342bdd613';
// The mailbox page exactly as the API serves it: its own nonce, and its own restrictive policy, so
// the browser blocks the confirmation script if the nonce and the policy ever disagree.
const mailboxPage = (locale?: 'en' | 'cs') => ({
  contentType: 'text/html',
  headers: { 'content-security-policy': registrationLinkPageCsp('synthetic-nonce') },
  body: renderRegistrationLinkPage('synthetic-nonce', locale),
});
const search = '?config_url=https%3A%2F%2Fproduct.example%2Fconfig&code_challenge=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ&code_challenge_method=S256';
// `secondary` styles "create account" (and so "back to sign in", HUGO-1858) as a filled button.
// `registrationCode: false` leaves `login_flow` out, as every product's config is until it opts in.
type Variant = { language: 'en' | 'cs'; secondary: boolean; registrationCode: boolean };
async function configure(page: Page, variant: Partial<Variant> = {}) {
  await page.addInitScript(({ language = 'en', secondary = false, registrationCode = true }) => {
    Object.assign(window, {
      __UOA_CLIENT_CONFIG__: {
        app_name: 'Example product', enabled_auth_methods: ['email_password'], language_config: language,
        ...(registrationCode ? { login_flow: { registration_code_enabled: true } } : {}),
        ui_theme: {
          colors: { bg: '#f8fafc', surface: '#ffffff', text: '#0f172a', muted: '#475569', primary: '#2563eb', primary_text: '#ffffff', ...(secondary ? { secondary: '#e2ddd5' } : {}), border: '#e2e8f0', danger: '#dc2626', danger_text: '#ffffff' },
          radii: { card: '16px', input: '8px', button: '8px' }, density: 'comfortable',
          typography: { font_family: 'sans', base_text_size: 'md' },
          button: { style: 'solid', ...(secondary ? { create_account: 'secondary' } : {}) }, card: { style: 'bordered' }, logo: { url: '', alt: 'Example product' },
        },
      }, __UOA_CONFIG_URL__: 'https://product.example/config',
    });
  }, variant);
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
  let codeGate: Promise<void> | undefined;
  let resendGate: Promise<void> | undefined;
  let resendFailure = false;
  await page.routeWebSocket('**/auth/registration/events?**', ws => { socket = ws; });
  await page.route('**/auth/registration/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/start')) {
      starts++;
      if (starts > 1 && resendGate) await resendGate;
      if (starts > 1 && resendFailure) return route.fulfill({ status: 500, json: { error: 'Request failed' } });
      expect(route.request().postDataJSON()).toEqual({ email: 'person@example.com' });
      return route.fulfill({ headers: { 'set-cookie': `uoa_registration_${id}=synthetic-browser-credential; HttpOnly; SameSite=Lax; Path=/auth` },
        json: { registration_id: id, message: 'We sent instructions to your email' } });
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
      socket.send(JSON.stringify({ type: 'registration.email_verified', status: 'verified' }));
    },
    setStatus: (next: string) => { status = next; },
    calls: () => calls,
    starts: () => starts,
    pauseCode: () => { let release = () => {}; codeGate = new Promise<void>(resolve => { release = resolve; }); return release; },
    pauseResend: () => { let release = () => {}; resendGate = new Promise<void>(resolve => { release = resolve; }); return release; },
    failResend: () => { resendFailure = true; },
  };
}

test('registration screen, keyboard entry, failed code and full paste recovery', async ({ page }, info) => {
  await configure(page); const server = await backend(page); await start(page);
  const fields = page.getByRole('textbox', { name: /Verification code \d \/ 6/ });
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
  await expect(page.getByRole('heading', { name: 'Set your password' })).toBeVisible();
  expect(server.calls()).toBe(2);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Set your password' })).toBeVisible();
});

test('confirmation in another browser advances the original over websocket without code entry', async ({ page, browser }, info) => {
  await configure(page); const server = await backend(page);
  await page.clock.install(); // No polling interval runs: advancement must follow the socket hint.
  await start(page);
  if (process.env.REGISTRATION_BASE_LINK_HTML) {
    // Auth is unchanged from #123: its old cross-device response kept code entry visible.
    await server.notify('verified');
    await expect(page.getByRole('status')).toContainText('Enter the code');
    await page.screenshot({ path: info.outputPath('before-original-continued.png'), fullPage: true });
    await server.notify('pending');
    await expect(page.getByRole('status')).toHaveCount(0);
  }
  const otherContext = await browser.newContext({ viewport: page.viewportSize() });
  try {
    const otherPage = await otherContext.newPage();
    await otherPage.route('**/auth/registration/link', async route => {
      if (route.request().method() === 'POST') {
        expect(route.request().postDataJSON()).toEqual({ token: 'synthetic-link-secret' });
        await server.notify('authorized');
        return route.fulfill({ json: { status: 'verified' } });
      }
      return route.fulfill(mailboxPage());
    });
    await otherPage.goto('http://127.0.0.1:5275/auth/registration/link#synthetic-link-secret');
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
    await otherPage.getByRole('button', { name: 'Verify email address' }).click();
    await expect(page.getByRole('heading', { name: 'Set your password' })).toBeVisible();
    expect(server.calls()).toBe(0);
    await expect(otherPage.getByRole('heading', { name: 'Email verified' })).toBeVisible();
    await expect(otherPage).toHaveURL('http://127.0.0.1:5275/auth/registration/link');
    expect(await otherContext.cookies()).toHaveLength(0);
    await page.screenshot({ path: info.outputPath('cross-device-original-continued.png'), fullPage: true });
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Set your password' })).toBeVisible();
  } finally { await otherContext.close(); }
});

test('requesting another email preserves the address and clears only the old code', async ({ page }, info) => {
  await configure(page); const server = await backend(page); await start(page);
  const fields = page.getByRole('textbox', { name: /Verification code \d \/ 6/ });
  await fields.nth(0).fill('A');
  const release = server.pauseResend();
  await page.getByRole('button', { name: 'Request a new email' }).click();
  await expect(page.getByRole('button', { name: /Sending/ })).toBeVisible();
  await page.screenshot({ path: info.outputPath('resend-loading.png'), fullPage: true });
  release();
  await expect(fields.nth(0)).toHaveValue('');
  await expect(page.getByText('person@example.com', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  expect(server.starts()).toBe(2);
});

test('link approval advances automatically when a blocked websocket falls back to polling', async ({ page }) => {
  await configure(page);
  await page.addInitScript(() => { Object.defineProperty(window, 'WebSocket', { value: undefined }); });
  const server = await backend(page);
  await page.clock.install();
  await start(page);
  server.setStatus('authorized');
  await page.clock.fastForward(11000);
  await expect(page.getByRole('heading', { name: 'Set your password' })).toBeVisible();
});

test('same-browser link confirmation advances the original registration tab', async ({ page }, info) => {
  await configure(page); const server = await backend(page); await start(page);
  const linkPage = await page.context().newPage();
  await linkPage.route('**/auth/registration/link', async route => {
    if (route.request().method() === 'POST') {
      expect(await route.request().headerValue('cookie')).toContain(`uoa_registration_${id}=`);
      await server.notify('authorized');
      return route.fulfill({ json: { status: 'verified' } });
    }
    return route.fulfill(mailboxPage());
  });
  await linkPage.goto('http://127.0.0.1:5275/auth/registration/link#synthetic-link-secret');
  await linkPage.screenshot({ path: info.outputPath('same-browser-confirmation.png'), fullPage: true });
  await linkPage.getByRole('button', { name: 'Verify email address' }).click();
  await expect(linkPage.getByRole('heading', { name: 'Email verified' })).toBeVisible();
  await linkPage.screenshot({ path: info.outputPath('same-browser-success.png'), fullPage: true });
  await expect(page.getByRole('heading', { name: 'Set your password' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('same-browser-original-continued.png'), fullPage: true });
  expect(server.calls()).toBe(0);
  await linkPage.close();
});

test('code entry shows partial input and verification loading before continuing', async ({ page }, info) => {
  await configure(page); const server = await backend(page); await start(page);
  const fields = page.getByRole('textbox', { name: /Verification code \d \/ 6/ });
  await fields.nth(0).pressSequentially('AB3K7');
  await page.screenshot({ path: info.outputPath('partial-code.png'), fullPage: true });
  const release = server.pauseCode();
  await fields.nth(5).fill('M');
  await expect(page.getByRole('status')).toContainText('Verifying');
  await page.screenshot({ path: info.outputPath('code-verifying.png'), fullPage: true });
  release();
  await expect(page.getByRole('heading', { name: 'Set your password' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('code-original-continued.png'), fullPage: true });
});

test('expiry and resend failure preserve a clear recovery screen', async ({ page }, info) => {
  await configure(page); const server = await backend(page); await start(page);
  await server.notify('expired');
  await expect(page.getByRole('textbox', { name: /Verification code \d \/ 6/ })).toHaveCount(0);
  await expect(page.getByText(/Open the link on any device/)).toHaveCount(0);
  await expect(page.getByText(/We've sent a verification link/)).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('registration-expired.png'), fullPage: true });
  server.failResend();
  await page.getByRole('button', { name: 'Request a new email' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.screenshot({ path: info.outputPath('resend-failed.png'), fullPage: true });
});

test('a rejected link shows its error without signing in or redirecting', async ({ page }, info) => {
  let postStatus = 503;
  await page.route('**/auth/registration/link', route => route.request().method() === 'POST'
    ? route.fulfill({ status: postStatus, json: { error: 'Request failed' } })
    : route.fulfill(mailboxPage()));
  await page.goto('/auth/registration/link#synthetic-expired-secret');
  const verify = page.getByRole('button', { name: 'Verify email address' });
  await verify.click();
  await expect(page.getByRole('status')).toContainText('Try again in a moment');
  await expect(verify).toBeEnabled();
  postStatus = 400;
  await verify.click();
  await expect(page.getByRole('status')).toContainText('This link has expired or is no longer valid');
  await expect(page.getByRole('status')).not.toContainText('Try again');
  await expect(verify).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('link-error.png'), fullPage: true });
  expect(await page.context().cookies()).toHaveLength(0);
  await page.goto('about:blank');
  await page.goto('/auth/registration/link');
  await page.getByRole('button', { name: 'Verify email address' }).click();
  await expect(page.getByRole('status')).toContainText('This link cannot be used');
  await expect(page.getByRole('button', { name: 'Verify email address' })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('link-missing-secret.png'), fullPage: true });
});

test('another-device link displays success without navigation or authentication', async ({ page }, info) => {
  if (process.env.REGISTRATION_BASE_LINK_HTML) {
    const beforeHtml = readFileSync(process.env.REGISTRATION_BASE_LINK_HTML, 'utf8');
    let rejectBefore = true;
    let releaseBefore = () => {};
    const beforeResponse = new Promise<void>(resolve => { releaseBefore = resolve; });
    await page.route('**/auth/registration/link', async route => {
      if (route.request().method() !== 'POST') return route.fulfill({ contentType: 'text/html', body: beforeHtml });
      await beforeResponse;
      return rejectBefore ? route.fulfill({ status: 400, json: { error: 'Request failed' } })
        : route.fulfill({ json: { status: 'verified' } });
    });
    await page.goto('/auth/registration/link#synthetic-link-secret');
    await page.screenshot({ path: info.outputPath('before-confirmation.png'), fullPage: true });
    await page.getByRole('button', { name: 'Verify email address' }).click();
    await expect(page.getByRole('status')).toHaveText('Verifying…');
    await page.screenshot({ path: info.outputPath('before-link-verifying.png'), fullPage: true });
    releaseBefore();
    await expect(page.getByRole('status')).toContainText('We could not verify');
    await page.screenshot({ path: info.outputPath('before-link-error.png'), fullPage: true });
    rejectBefore = false;
    await page.getByRole('button', { name: 'Verify email address' }).click();
    await expect(page.getByRole('heading', { name: 'Email verified' })).toBeVisible();
    await page.screenshot({ path: info.outputPath('before-success.png'), fullPage: true });
    await page.goto('about:blank');
    await page.goto('/auth/registration/link');
    await page.getByRole('button', { name: 'Verify email address' }).click();
    await expect(page.getByRole('status')).toContainText('This link cannot be used');
    await page.screenshot({ path: info.outputPath('before-link-missing-secret.png'), fullPage: true });
    await page.unroute('**/auth/registration/link');
    await page.goto('about:blank'); // Force a new document instead of a fragment-only navigation.
  }
  let release = () => {};
  const confirmation = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/auth/registration/link', async route => {
    if (route.request().method() === 'POST') {
      expect(route.request().postDataJSON()).toEqual({ token: 'synthetic-link-secret' });
      await confirmation;
      return route.fulfill({ json: { status: 'verified' } });
    }
    return route.fulfill(mailboxPage());
  });
  await page.goto('/auth/registration/link#synthetic-link-secret');
  await expect(page).toHaveURL(/\/auth\/registration\/link$/);
  await expect(page.getByText(/Only confirm if you requested this registration/)).toBeVisible();
  await page.screenshot({ path: info.outputPath('after-confirmation.png'), fullPage: true });
  await page.getByRole('button', { name: 'Verify email address' }).click();
  await expect(page.getByRole('status')).toHaveText('Verifying…');
  await page.screenshot({ path: info.outputPath('link-verifying.png'), fullPage: true });
  release();
  await expect(page.getByRole('heading', { name: 'Email verified' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('will continue automatically');
  await expect(page.getByRole('status')).toContainText('has not signed you in');
  await expect(page.getByRole('button', { name: 'Verify email address' })).toHaveCount(0);
  // The confirmation sentence sits directly under the body text, without the removed button's gap.
  const bodyBox = await page.getByText('Your email address is confirmed.', { exact: true }).boundingBox();
  const statusBox = await page.getByRole('status').boundingBox();
  if (!bodyBox || !statusBox) throw new Error('Success text is not rendered');
  const gap = statusBox.y - (bodyBox.y + bodyBox.height);
  expect(gap).toBeGreaterThanOrEqual(0);
  expect(gap).toBeLessThanOrEqual(20);
  expect(await page.context().cookies()).toHaveLength(0);
  await page.screenshot({ path: info.outputPath('cross-device-success.png'), fullPage: true });
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
  await page.setContent(buildRegistrationVerificationTemplate({ link, code: 'AB3K7M' }).html);
  await expect(page.getByRole('link', { name: 'Verify email address' })).toHaveAttribute('href', link);
  await expect(page.getByText('AB3K7M', { exact: true })).toHaveCSS('font-size', '32px');
  await expect(page.getByText('AB3K7M', { exact: true })).toHaveCSS('font-weight', '700');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('after-email.png'), fullPage: true });
});

test('the Czech registration screen keeps the way back to sign in as a filled-secondary button', async ({ page }, info) => {
  await configure(page, { language: 'cs', secondary: true }); await backend(page); await start(page, 'cs');
  await expect(page.getByText(/Na person@example.com jsme ti poslali ověřovací odkaz a šestimístný kód\./)).toBeVisible();
  await expect(page.getByText('Otevři odkaz na jakémkoli zařízení, nebo pokračuj zadáním kódu níže.')).toBeVisible();
  await expect(page.getByRole('textbox', { name: /Ověřovací kód \d \/ 6/ })).toHaveCount(6);
  await expect(page.getByRole('button', { name: 'Poslat nový e-mail' })).toBeVisible();
  const back = page.getByRole('button', { name: 'Zpět na přihlášení', exact: true });
  await expect(back).toHaveCount(1);
  await expect(back).toHaveClass(/uoa-color-secondary/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('czech-registration.png'), fullPage: true });
  await back.click();
  await expect(page.getByRole('heading', { name: 'Přihlášení' })).toBeVisible();
});

test('without a secondary theme the code-entry screen offers a plain back-to-sign-in link', async ({ page }) => {
  await configure(page); await backend(page); await start(page);
  const back = page.getByRole('button', { name: 'Back to sign in', exact: true });
  await expect(back).toHaveCount(1);
  await expect(back).not.toHaveClass(/uoa-color-secondary/);
  await back.click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  // Going back forgot the pending registration: a refresh opens sign-in, not the code screen.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toHaveCount(0);
});

// The browser context locale is what makes Chromium send `Accept-Language: cs` (extra HTTP headers
// cannot override it).
test.describe('Czech mailbox landing', () => {
test.use({ locale: 'cs' });
test('the Czech confirmation page follows Accept-Language: cs through verify, retry and final failures', async ({ page }, info) => {
  expect(await page.evaluate(() => navigator.languages[0])).toBe('cs');
  let postStatus = 200;
  let failNetwork = false;
  let expectedToken = 'synthetic-link-secret';
  await page.route('**/auth/registration/link', async route => {
    if (route.request().method() === 'POST') {
      expect(route.request().postDataJSON()).toEqual({ token: expectedToken });
      if (failNetwork) return route.abort();
      return route.fulfill({ status: postStatus, json: postStatus === 200 ? { status: 'verified' } : { error: 'Request failed' } });
    }
    // Same resolution as the API route: the GET request's Accept-Language picks the language.
    const locale = resolveEmailLocale((await route.request().allHeaders())['accept-language']);
    return route.fulfill(mailboxPage(locale));
  });
  await page.goto('/auth/registration/link#synthetic-link-secret');
  await expect(page.locator('html')).toHaveAttribute('lang', 'cs');
  await expect(page.getByRole('heading', { name: 'Potvrď svůj e-mail' })).toBeVisible();
  await expect(page.getByText('Potvrzuj jen registraci, kterou zakládáš ty.')).toBeVisible();
  await page.screenshot({ path: info.outputPath('link-cs-confirmation.png'), fullPage: true });
  const verify = page.getByRole('button', { name: 'Ověřit e-mail', exact: true });
  failNetwork = true;
  await verify.click();
  await expect(page.getByRole('status')).toContainText('Nepodařilo se spojit se serverem. Zkontroluj připojení a zkus to znovu.');
  await expect(verify).toBeEnabled();
  failNetwork = false; postStatus = 503;
  await verify.click();
  await expect(page.getByRole('status')).toContainText('Odkaz teď nejde ověřit. Zkus to za chvíli znovu.');
  await expect(verify).toBeEnabled();
  postStatus = 200;
  await verify.click();
  await expect(page.getByRole('heading', { name: 'E-mail je ověřený' })).toBeVisible();
  await expect(page.getByText('Tvoje e-mailová adresa je potvrzená.')).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('Registrace v původním okně teď sama pokračuje. Toto zařízení se nepřihlásilo.');
  await expect(verify).toHaveCount(0);
  expect(await page.context().cookies()).toHaveLength(0);
  await page.screenshot({ path: info.outputPath('link-cs-success.png'), fullPage: true });
  postStatus = 400; expectedToken = 'synthetic-expired-secret';
  await page.goto('about:blank');
  await page.goto('/auth/registration/link#synthetic-expired-secret');
  await page.getByRole('button', { name: 'Ověřit e-mail', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Odkaz vypršel nebo už neplatí. Nový e-mail si nech poslat z okna registrace.');
  await expect(page.getByRole('button', { name: 'Ověřit e-mail' })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('link-cs-error.png'), fullPage: true });
  await page.goto('about:blank');
  await page.goto('/auth/registration/link');
  await page.getByRole('button', { name: 'Ověřit e-mail', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Tenhle odkaz nejde použít. Nový e-mail si nech poslat z okna registrace.');
  await page.screenshot({ path: info.outputPath('link-cs-missing-secret.png'), fullPage: true });
});
});

test('the Czech verification email keeps the button, the link and the large spaced code', async ({ page }, info) => {
  const link = 'https://auth.example.com/auth/registration/link#synthetic-link-secret';
  await page.setContent(buildRegistrationVerificationTemplate({ link, code: 'AB3K7M', locale: 'cs' }).html);
  await expect(page.locator('html')).toHaveAttribute('lang', 'cs');
  await expect(page.getByRole('heading', { name: 'Ověř svůj e-mail' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Ověřit e-mail' })).toHaveAttribute('href', link);
  await expect(page.getByText('Nebo zadej tento kód:')).toBeVisible();
  await expect(page.getByText('AB3K7M', { exact: true })).toHaveCSS('font-size', '32px');
  await expect(page.getByText('AB3K7M', { exact: true })).toHaveCSS('font-weight', '700');
  await expect(page.getByText(/Odkaz i kód platí 24 hodin\. Odkaz jde použít jen jednou\./)).toBeVisible();
  await expect(page.getByText(/Toto zařízení se nepřihlásí\./)).toBeVisible();
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
  await expect(page.getByRole('textbox', { name: /Verification code/ })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Check your email' })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('original-flow-sent.png'), fullPage: true });
  // The page-level link is still the way back to sign in, exactly as before.
  await page.getByRole('button', { name: 'Back to sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  expect(requests).toEqual(['/auth/register']);
});
