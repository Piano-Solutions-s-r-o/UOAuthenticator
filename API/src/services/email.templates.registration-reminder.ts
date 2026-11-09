import { registrationReminderCopy, registrationVerificationCopy } from './email.registration-copy.js';
import { escapeHtml, logoHtml, resolveTheme, type EmailLocale, type EmailTheme } from './email.templates.js';

const FONT = 'ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif';

/**
 * The reminder to an unconfirmed registration (HUGO-2424). The same card, logo, theme and button as
 * the registration e-mail (`email.templates.registration.ts`); it carries no code, only the link.
 */
export function buildRegistrationReminderTemplate(params: {
  link: string;
  theme?: Partial<EmailTheme>;
  locale?: EmailLocale;
}): { subject: string; text: string; html: string } {
  const t = resolveTheme(params.theme);
  const copy = registrationReminderCopy(params.locale);
  const buttonLabel = registrationVerificationCopy(params.locale).buttonLabel;
  const text = [copy.heading, '', copy.body, params.link, '', copy.closing, '', copy.ignoreLabel].join('\n');
  const fontLink = t.fontImportUrl
    ? `<link rel="stylesheet" href="${escapeHtml(t.fontImportUrl)}" />`
    : '';
  const html = `<!doctype html>
<html lang="${params.locale ?? 'en'}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(copy.subject)}</title>
    ${fontLink}
  </head>
  <body style="margin:0;padding:0;background-color:${t.bg};" bgcolor="${t.bg}">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background-color:${t.bg};padding:24px 12px;" bgcolor="${t.bg}">
      <tr>
        <td align="center" bgcolor="${t.bg}">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:560px;background-color:${t.surface};border-radius:${t.cardRadius};overflow:hidden;border:1px solid ${t.border};" bgcolor="${t.surface}">
            ${logoHtml(t)}
            <tr>
              <td style="padding:24px 24px 8px 24px;font-family:${FONT};color:${t.text};">
                <h1 style="margin:0;font-size:20px;line-height:28px;color:${t.text};">${escapeHtml(copy.heading)}</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:0 24px 16px 24px;font-family:${FONT};color:${t.text};font-size:14px;line-height:22px;">
                ${escapeHtml(copy.body)}
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:0 24px 20px 24px;">
                <a href="${escapeHtml(params.link)}" style="display:inline-block;background-color:${t.primary};color:${t.primaryText};text-decoration:none;font-family:${FONT};font-size:14px;line-height:20px;font-weight:bold;padding:12px 16px;border-radius:${t.buttonRadius};">${escapeHtml(buttonLabel)}</a>
              </td>
            </tr>
            <tr>
              <td style="padding:0 24px 16px 24px;font-family:${FONT};color:${t.text};font-size:14px;line-height:22px;">
                ${escapeHtml(copy.closing)}
              </td>
            </tr>
            <tr>
              <td style="padding:0 24px 24px 24px;font-family:${FONT};color:${t.muted};font-size:12px;line-height:18px;">
                ${escapeHtml(copy.ignoreLabel)}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
  return { subject: copy.subject, text, html };
}
