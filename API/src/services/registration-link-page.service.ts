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
  opening: string;
  complete: string;
  signIn: string;
  expired: string;
  restart: string;
  /** No connection, 429 or 5xx: the only answers that keep the secret and offer a retry. */
  unreachable: string;
  retry: string;
};

/**
 * The page is opened from a mailbox, so its language follows the GET request's Accept-Language
 * (`resolveEmailLocale`, HUGO-1815), like the email that linked to it. Czech is informal (tykání).
 * Nothing here says where to go: the page sends the person on, or offers the one way on.
 */
const LINK_PAGE_COPY: Record<EmailLocale, LinkPageCopy> = {
  en: {
    opening: 'Opening Hugo…',
    complete: 'Registration is complete.',
    signIn: 'Sign in',
    expired: 'This link is no longer valid',
    restart: 'Start registration again',
    unreachable: 'We could not reach the server.',
    retry: 'Try again',
  },
  cs: {
    opening: 'Otevírám Hugo…',
    complete: 'Registrace je hotová.',
    signIn: 'Přihlásit se',
    expired: 'Odkaz už neplatí',
    restart: 'Začít registraci znovu',
    unreachable: 'Nepodařilo se spojit se serverem.',
    retry: 'Zkusit znovu',
  },
};

const BUTTON_STYLE = 'display:none;padding:12px 20px;border:0;border-radius:999px;background:#FFDF2C;color:#1B1B1B;font:inherit;font-weight:600;text-decoration:none;cursor:pointer;';

/** Self-contained card: the mailbox landing has no config, theme or product session to draw on. */
function renderCard(locale: EmailLocale, copy: LinkPageCopy): string {
  return `<!doctype html>
<html lang="${locale}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(copy.opening)}</title>
  </head>
  <body style="margin:0;background:#F8F6F2;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1B1B1B;">
    <div style="max-width:400px;margin:48px auto;padding:24px;">
      <div style="display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:24px;font-size:32px;font-weight:600;letter-spacing:-0.02em;">
        <svg width="32" height="32" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="12.5" fill="none" stroke="#FFDF2C" stroke-width="6"/></svg>Hugo
      </div>
      <div style="background:#ffffff;border:1px solid #E8E4DE;border-radius:28px;padding:32px;">
        <h1 id="message" aria-live="polite" style="margin:0;font-size:24px;line-height:1.3;">${escapeHtml(copy.opening)}</h1>
        <a id="next" style="${BUTTON_STYLE}margin-top:24px;"></a>
        <button id="retry" type="button" style="${BUTTON_STYLE}margin-top:24px;">${escapeHtml(copy.retry)}</button>
      </div>
    </div>
  </body>
</html>`;
}

/**
 * The page's own Content-Security-Policy (it replaces the global helmet one): only the inline
 * script carrying this response's nonce may run, and it may only call this origin.
 */
export function registrationLinkPageCsp(nonce: string): string {
  return `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`;
}

/**
 * Isolated mailbox landing: no config fetch or third-party assets, and no effect on GET. Its script
 * takes the secret out of the address, posts it at once and goes wherever the answer says.
 */
export function renderRegistrationLinkPage(nonce: string, locale: EmailLocale = 'en'): string {
  // An empty nonce would render a script the browser blocks (the page would stay on its first line).
  if (!/^[A-Za-z0-9+/=_-]+$/.test(nonce)) throw new Error('A CSP nonce is required');
  const copy = LINK_PAGE_COPY[locale] ?? LINK_PAGE_COPY.en;
  // Static copy only, but `<` is escaped so no string can ever close the script element.
  const strings = JSON.stringify(copy).replaceAll('<', '\\u003c');
  const script = `<script nonce="${nonce}">
(() => {
  const copy = ${strings};
  const token = location.hash.slice(1);
  history.replaceState(null, '', location.pathname);
  const message = document.getElementById('message');
  const next = document.getElementById('next');
  const retry = document.getElementById('retry');
  const final = (text, href, label) => {
    message.textContent = text;
    retry.style.display = 'none';
    if (!href) return;
    next.href = href;
    next.textContent = label;
    next.style.display = 'inline-block';
  };
  const unreachable = () => { message.textContent = copy.unreachable; retry.style.display = 'inline-block'; };
  const open = async () => {
    message.textContent = copy.opening;
    retry.style.display = 'none';
    if (!token) { final(copy.expired); return; }
    let response;
    try {
      response = await fetch('/auth/registration/link', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }), credentials: 'same-origin'
      });
    } catch {
      unreachable();
      return;
    }
    if (response.status === 429 || response.status >= 500) { unreachable(); return; }
    if (!response.ok) { final(copy.expired); return; }
    const result = await response.json().catch(() => ({}));
    if (result.status === 'continue') location.replace(result.next);
    else if (result.status === 'complete') final(copy.complete, result.next, copy.signIn);
    else if (result.status === 'expired') final(copy.expired, result.next, copy.restart);
    else unreachable();
  };
  retry.addEventListener('click', open);
  open();
})();
</script>`;
  return renderCard(locale, copy).replace('</body>', () => `${script}</body>`);
}
