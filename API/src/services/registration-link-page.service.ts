function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Self-contained card: the mailbox landing has no config, theme or product session to draw on. */
function renderInviteHtml(params: {
  title: string;
  body: string;
  primaryAction: { id: string; label: string };
}): string {
  const button = `<button id="${escapeHtml(params.primaryAction.id)}" type="button" style="display:inline-block;padding:12px 16px;border:0;border-radius:12px;background:#111827;color:#ffffff;font:inherit;font-weight:600;cursor:pointer;">${escapeHtml(params.primaryAction.label)}</button>`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(params.title)}</title>
  </head>
  <body style="margin:0;background:#f3f4f6;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827;">
    <div style="max-width:560px;margin:48px auto;padding:24px;">
      <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:16px;padding:32px;">
        <h1 style="margin:0 0 16px 0;font-size:28px;line-height:1.2;">${escapeHtml(params.title)}</h1>
        <p style="margin:0 0 24px 0;font-size:16px;line-height:1.6;">${escapeHtml(params.body)}</p>
        <div style="display:flex;gap:12px;flex-wrap:wrap;">${button}</div>
      </div>
    </div>
  </body>
</html>`;
}

/** Isolated mailbox landing: no config fetch, third-party assets or OAuth redirect. */
export function renderRegistrationLinkPage(nonce: string): string {
  const html = renderInviteHtml({
    title: 'Confirm your email',
    body: 'Confirm to continue registration in the browser where you started. Only confirm if you requested this registration.',
    primaryAction: { id: 'verify', label: 'Verify email address' },
  });
  const result = '<p id="result" role="status" aria-live="polite"></p>';
  const script = `<script nonce="${nonce}">
(() => {
  let token = location.hash.slice(1);
  history.replaceState(null, '', location.pathname);
  const button = document.getElementById('verify');
  const result = document.getElementById('result');
  button.addEventListener('click', async () => {
    if (!token) { result.textContent = 'This link cannot be used. Request a new email from the registration screen.'; return; }
    button.disabled = true;
    result.textContent = 'Verifying…';
    try {
      const response = await fetch('/auth/registration/link', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }), credentials: 'same-origin'
      });
      if (!response.ok) throw new Error('verification failed');
      token = '';
      document.querySelector('h1').textContent = 'Email verified';
      document.querySelector('h1').nextElementSibling.textContent = 'Your email address is confirmed.';
      result.textContent = 'Your original registration screen will continue automatically. This page has not signed you in.';
      button.remove();
    } catch {
      result.textContent = 'We could not verify this link. Try again, or request a new email from the registration screen.';
      button.disabled = false;
    }
  });
})();
</script>`;
  return html.replace('</button>', `</button>${result}`)
    .replace('</body>', `${script}</body>`);
}
