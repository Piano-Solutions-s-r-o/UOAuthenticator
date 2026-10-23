import type { EmailLocale } from './email.templates.js';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

type LinkPageCopy = {
  title: string;
  body: string;
  button: string;
  verifying: string;
  successTitle: string;
  successBody: string;
  successStatus: string;
  /**
   * Expired, exhausted or malformed: it can never succeed on retry, so the button goes away.
   * Replaying an already-used link stays idempotent (the API answers 200 and the page shows
   * success), which is why this copy does not claim the link was used.
   */
  rejected: string;
  /** No secret in the fragment (a damaged or already-consumed address). */
  missingSecret: string;
  network: string;
  /** 429 and 5xx: the only server answers that keep the retry button. */
  retryLater: string;
};

/**
 * The page is opened from a mailbox, so its language follows the GET request's Accept-Language
 * (`resolveEmailLocale`, HUGO-1815), like the email that linked to it. Czech is informal (tykání).
 */
const LINK_PAGE_COPY: Record<EmailLocale, LinkPageCopy> = {
  en: {
    title: 'Confirm your email',
    body: 'Confirm to continue registration in the browser where you started. Only confirm if you requested this registration.',
    button: 'Verify email address',
    verifying: 'Verifying…',
    successTitle: 'Email verified',
    successBody: 'Your email address is confirmed.',
    successStatus: 'Your original registration screen will continue automatically. This page has not signed you in.',
    rejected: 'This link has expired or is no longer valid. Request a new email from the registration screen.',
    missingSecret: 'This link cannot be used. Request a new email from the registration screen.',
    network: 'We could not reach the server. Check your connection and try again.',
    retryLater: 'We could not verify this link right now. Try again in a moment.',
  },
  cs: {
    title: 'Potvrď svůj e-mail',
    body: 'Po potvrzení bude registrace pokračovat v prohlížeči, kde začala. Potvrzuj jen registraci, kterou zakládáš ty.',
    button: 'Ověřit e-mail',
    verifying: 'Ověřuji…',
    successTitle: 'E-mail je ověřený',
    successBody: 'Tvoje e-mailová adresa je potvrzená.',
    successStatus: 'Registrace v původním okně teď sama pokračuje. Toto zařízení se nepřihlásilo.',
    rejected: 'Odkaz vypršel nebo už neplatí. Nový e-mail si nech poslat z okna registrace.',
    missingSecret: 'Tenhle odkaz nejde použít. Nový e-mail si nech poslat z okna registrace.',
    network: 'Nepodařilo se spojit se serverem. Zkontroluj připojení a zkus to znovu.',
    retryLater: 'Odkaz teď nejde ověřit. Zkus to za chvíli znovu.',
  },
};

/** Self-contained card: the mailbox landing has no config, theme or product session to draw on. */
function renderCard(locale: EmailLocale, copy: LinkPageCopy): string {
  return `<!doctype html>
<html lang="${locale}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(copy.title)}</title>
  </head>
  <body style="margin:0;background:#f3f4f6;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827;">
    <div style="max-width:560px;margin:48px auto;padding:24px;">
      <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:16px;padding:32px;">
        <h1 style="margin:0 0 16px 0;font-size:28px;line-height:1.2;">${escapeHtml(copy.title)}</h1>
        <p style="margin:0 0 24px 0;font-size:16px;line-height:1.6;">${escapeHtml(copy.body)}</p>
        <div style="display:flex;gap:12px;flex-wrap:wrap;"><button id="verify" type="button" style="display:inline-block;padding:12px 16px;border:0;border-radius:12px;background:#111827;color:#ffffff;font:inherit;font-weight:600;cursor:pointer;">${escapeHtml(copy.button)}</button></div><p id="result" role="status" aria-live="polite" style="margin:16px 0 0 0;font-size:16px;line-height:1.6;"></p>
      </div>
    </div>
  </body>
</html>`;
}

/**
 * The page's own Content-Security-Policy (it replaces the global helmet one): only the inline
 * confirmation script carrying this response's nonce may run, and it may only call this origin.
 */
export function registrationLinkPageCsp(nonce: string): string {
  return `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`;
}

/** Isolated mailbox landing: no config fetch, third-party assets or OAuth redirect. */
export function renderRegistrationLinkPage(nonce: string, locale: EmailLocale = 'en'): string {
  // An empty nonce would render a script the browser blocks (the button would do nothing).
  if (!/^[A-Za-z0-9+/=_-]+$/.test(nonce)) throw new Error('A CSP nonce is required');
  const copy = LINK_PAGE_COPY[locale] ?? LINK_PAGE_COPY.en;
  // Static copy only, but `<` is escaped so no string can ever close the script element.
  const strings = JSON.stringify(copy).replaceAll('<', '\\u003c');
  // A rejected link (expired, exhausted or malformed) can never succeed on retry, so only a
  // transport or server failure keeps the button; every final outcome removes it.
  const script = `<script nonce="${nonce}">
(() => {
  const copy = ${strings};
  let token = location.hash.slice(1);
  history.replaceState(null, '', location.pathname);
  const button = document.getElementById('verify');
  const actions = button.parentElement;
  const body = document.querySelector('h1').nextElementSibling;
  const result = document.getElementById('result');
  const finish = message => { token = ''; actions.remove(); body.style.marginBottom = '0'; result.textContent = message; };
  const retry = message => { button.disabled = false; result.textContent = message; };
  button.addEventListener('click', async () => {
    if (!token) { finish(copy.missingSecret); return; }
    button.disabled = true;
    result.textContent = copy.verifying;
    let response;
    try {
      response = await fetch('/auth/registration/link', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }), credentials: 'same-origin'
      });
    } catch {
      retry(copy.network);
      return;
    }
    if (response.ok) {
      document.querySelector('h1').textContent = copy.successTitle;
      body.textContent = copy.successBody;
      finish(copy.successStatus);
    } else if (response.status === 429 || response.status >= 500) {
      retry(copy.retryLater);
    } else {
      finish(copy.rejected);
    }
  });
})();
</script>`;
  return renderCard(locale, copy).replace('</body>', () => `${script}</body>`);
}
