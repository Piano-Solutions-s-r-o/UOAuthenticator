import { EMAIL_TOKEN_TTL_MS } from '../config/constants.js';

type EmailTemplate = {
  subject: string;
  text: string;
  html: string;
};

/** Locales we hand-author email copy for. Anything else falls back to English. */
export type EmailLocale = 'en' | 'cs';

type RegistrationCopy = {
  subject: string;
  heading: string;
  /** Body sentence shown above the button (HTML) and re-used as the text intro. */
  body: string;
  buttonLabel: string;
  expiry: string;
  fallbackLabel: string;
  ignoreLabel: string;
};

/**
 * Sign-in / registration email copy in Hugo's voice (HUGO-553). One neutral
 * template serves login-link, verify-email, set-password and account-exists,
 * so the wording must read naturally for both a returning login and finishing
 * signup. English is the source; unsupported locales fall back to it.
 */
const REGISTRATION_COPY: Record<EmailLocale, RegistrationCopy> = {
  en: {
    subject: 'Your sign-in link',
    heading: "Let's get you in",
    body: "You're one tap away. Use the button below to reach your account or finish signing up.",
    buttonLabel: 'Continue',
    expiry: `Tick tock — this link is time-limited and one use only.`,
    fallbackLabel: 'Button playing dead? Paste this URL into your browser:',
    ignoreLabel: "Wasn't you? Pretend this never happened.",
  },
  cs: {
    subject: 'Váš přihlašovací odkaz',
    heading: 'Pojďme vás přihlásit',
    body: 'Jste jen jedno kliknutí od cíle. Klikněte na tlačítko níže a dostanete se ke svému účtu nebo dokončíte registraci.',
    buttonLabel: 'Pokračovat',
    expiry: `Tik ťak — odkaz je časově omezený a použít ho lze jen jednou.`,
    fallbackLabel: 'Tlačítko nereaguje? Zkopírujte tuto adresu do prohlížeče:',
    ignoreLabel: 'Tohle jste nebyl/a vy? Tak na to rychle zapomeňte.',
  },
};

function registrationCopy(locale?: EmailLocale): RegistrationCopy {
  return REGISTRATION_COPY[locale ?? 'en'] ?? REGISTRATION_COPY.en;
}

/** Subset of config theme colors used to style emails. */
export type EmailTheme = {
  bg: string;
  surface: string;
  text: string;
  muted: string;
  primary: string;
  primaryText: string;
  border: string;
  buttonRadius: string;
  cardRadius: string;
  logoUrl?: string;
  logoAlt?: string;
  logoText?: string;
  logoFontSize?: string;
  logoFontWeight?: string;
  logoFontFamily?: string;
  logoColor?: string;
  fontImportUrl?: string;
};

const DEFAULT_THEME: EmailTheme = {
  bg: '#f6f7fb',
  surface: '#ffffff',
  text: '#111827',
  muted: '#6b7280',
  primary: '#111827',
  primaryText: '#ffffff',
  border: '#e8eaf0',
  buttonRadius: '10px',
  cardRadius: '12px',
};

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function tokenTtlMinutes(): number {
  return Math.max(1, Math.round(EMAIL_TOKEN_TTL_MS / (60 * 1000)));
}

export function resolveTheme(theme?: Partial<EmailTheme>): EmailTheme {
  if (!theme) return DEFAULT_THEME;
  return { ...DEFAULT_THEME, ...theme };
}

export function logoHtml(t: EmailTheme): string {
  if (t.logoUrl) {
    const alt = escapeHtml(t.logoAlt ?? '');
    const src = escapeHtml(t.logoUrl);
    return `<tr>
  <td align="center" style="padding:24px 24px 0 24px;">
    <img src="${src}" alt="${alt}" height="32" style="display:block;height:32px;width:auto;max-width:200px;" />
  </td>
</tr>`;
  }

  if (t.logoText) {
    const fontSize = t.logoFontSize ?? '24px';
    const fontWeight = t.logoFontWeight ?? '600';
    const fontFamily = t.logoFontFamily
      ? `${escapeHtml(t.logoFontFamily)},ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif`
      : 'ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif';
    const color = t.logoColor ?? t.text;
    return `<tr>
  <td align="center" style="padding:24px 24px 0 24px;font-family:${fontFamily};font-size:${escapeHtml(fontSize)};font-weight:${escapeHtml(fontWeight)};color:${escapeHtml(color)};">
    ${escapeHtml(t.logoText)}
  </td>
</tr>`;
  }

  return '';
}

function buildEmailHtml(params: {
  theme: EmailTheme;
  subject: string;
  heading: string;
  body: string;
  bodyHtml?: string;
  buttonLabel: string;
  buttonUrl: string;
  minutes: number;
  lang?: string;
  expiryLabel?: string;
  fallbackLabel?: string;
  ignoreLabel?: string;
  /**
   * Notification mode for emails sent to admins (no expiry copy, no
   * copy-paste URL block, no "ignore if you did not request" footer).
   */
  notification?: boolean;
}): string {
  const t = params.theme;
  const escapedLink = escapeHtml(params.buttonUrl);
  const expiryLabel =
    params.expiryLabel ?? `This link expires in ${params.minutes} minutes and can only be used once.`;
  const fallbackLabel =
    params.fallbackLabel ?? 'If the button does not work, copy and paste this URL into your browser:';
  const ignoreLabel = params.ignoreLabel ?? 'If you did not request this, you can ignore this email.';

  const fontLink = t.fontImportUrl
    ? `<link rel="stylesheet" href="${escapeHtml(t.fontImportUrl)}" />`
    : '';

  const footerRows = params.notification
    ? ''
    : `<tr>
              <td style="padding:0 24px 16px 24px;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${t.muted};font-size:12px;line-height:18px;">
                ${escapeHtml(expiryLabel)}
              </td>
            </tr>
            <tr>
              <td style="padding:0 24px 16px 24px;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${t.muted};font-size:12px;line-height:18px;">
                ${escapeHtml(fallbackLabel)}
                <div style="margin-top:8px;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;color:${t.text};">${escapedLink}</div>
              </td>
            </tr>
            <tr>
              <td style="padding:0 24px 24px 24px;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${t.muted};font-size:12px;line-height:18px;">
                ${escapeHtml(ignoreLabel)}
              </td>
            </tr>`;

  return `<!doctype html>
<html lang="${escapeHtml(params.lang ?? 'en')}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(params.subject)}</title>
    ${fontLink}
  </head>
  <body style="margin:0;padding:0;background-color:${t.bg};" bgcolor="${t.bg}">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background-color:${t.bg};padding:24px 12px;" bgcolor="${t.bg}">
      <tr>
        <td align="center" bgcolor="${t.bg}">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:560px;background-color:${t.surface};border-radius:${t.cardRadius};overflow:hidden;border:1px solid ${t.border};" bgcolor="${t.surface}">
            ${logoHtml(t)}
            <tr>
              <td style="padding:24px 24px 8px 24px;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${t.text};">
                <h1 style="margin:0;font-size:20px;line-height:28px;color:${t.text};">${escapeHtml(params.heading)}</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:0 24px 16px 24px;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${t.text};font-size:14px;line-height:22px;">
                ${params.bodyHtml ?? escapeHtml(params.body)}
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:0 24px 20px 24px;">
                <a href="${escapedLink}" style="display:inline-block;background-color:${t.primary};color:${t.primaryText};text-decoration:none;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:20px;padding:12px 16px;border-radius:${t.buttonRadius};">
                  ${escapeHtml(params.buttonLabel)}
                </a>
              </td>
            </tr>
            ${footerRows}
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export function buildRegistrationLinkTemplate(params: {
  link: string;
  theme?: Partial<EmailTheme>;
  locale?: EmailLocale;
}): EmailTemplate {
  return buildNeutralSignInLinkTemplate(params);
}

function buildNeutralSignInLinkTemplate(
  params: {
    link: string;
    theme?: Partial<EmailTheme>;
    locale?: EmailLocale;
  },
): EmailTemplate {
  const theme = resolveTheme(params.theme);
  const copy = registrationCopy(params.locale);

  const subject = copy.subject;
  const text = [
    copy.heading,
    '',
    copy.body,
    params.link,
    '',
    copy.expiry,
    '',
    copy.ignoreLabel,
  ].join('\n');

  const html = buildEmailHtml({
    theme,
    subject,
    heading: copy.heading,
    body: copy.body,
    buttonLabel: copy.buttonLabel,
    buttonUrl: params.link,
    minutes: 0,
    lang: params.locale ?? 'en',
    expiryLabel: copy.expiry,
    fallbackLabel: copy.fallbackLabel,
    ignoreLabel: copy.ignoreLabel,
  });

  return { subject, text, html };
}

export function buildVerifyEmailSetPasswordTemplate(params: {
  link: string;
  theme?: Partial<EmailTheme>;
  locale?: EmailLocale;
}): EmailTemplate {
  return buildRegistrationLinkTemplate(params);
}

export function buildVerifyEmailTemplate(params: {
  link: string;
  theme?: Partial<EmailTheme>;
  locale?: EmailLocale;
}): EmailTemplate {
  return buildRegistrationLinkTemplate(params);
}

export function buildLoginLinkTemplate(params: {
  link: string;
  theme?: Partial<EmailTheme>;
  locale?: EmailLocale;
}): EmailTemplate {
  return buildNeutralSignInLinkTemplate(params);
}

export function buildTeamInviteTemplate(params: {
  link: string;
  organisationName: string;
  teamName: string;
  inviteeName?: string;
  trackingPixelUrl?: string;
  theme?: Partial<EmailTheme>;
}): EmailTemplate {
  const minutes = tokenTtlMinutes();
  const theme = resolveTheme(params.theme);
  const recipient = params.inviteeName?.trim() ? `${params.inviteeName.trim()}, ` : '';
  const subject = `You have been invited to join ${params.teamName}`;
  const body =
    `${recipient}you have been invited to join the ${params.teamName} team on ${params.organisationName}. ` +
    'Click the button below to accept the invitation.';
  const text = [
    `Invitation to join ${params.teamName}`,
    '',
    `${recipient}you have been invited to join the ${params.teamName} team on ${params.organisationName}.`,
    'Use this link to accept the invitation:',
    params.link,
    '',
    `This link expires in ${minutes} minutes and can only be used once.`,
    '',
    'If you did not expect this invitation, you can ignore this email.',
  ].join('\n');

  const html = buildEmailHtml({
    theme,
    subject,
    heading: `Join ${params.teamName}`,
    body,
    bodyHtml: params.trackingPixelUrl
      ? `${escapeHtml(body)}<img src="${escapeHtml(params.trackingPixelUrl)}" alt="" width="1" height="1" style="display:none;" />`
      : undefined,
    buttonLabel: 'Accept invitation',
    buttonUrl: params.link,
    minutes,
  });

  return { subject, text, html };
}

export function buildAccessRequestNotificationTemplate(params: {
  reviewUrl: string;
  requesterEmail: string;
  requesterName?: string | null;
  organisationName: string;
  teamName: string;
  theme?: Partial<EmailTheme>;
}): EmailTemplate {
  const theme = resolveTheme(params.theme);
  const requester = params.requesterName?.trim()
    ? `${params.requesterName.trim()} <${params.requesterEmail}>`
    : params.requesterEmail;
  const subject = `${requester} requested access to ${params.teamName}`;
  const text = [
    'Access request received',
    '',
    `${requester} requested access to ${params.teamName} on ${params.organisationName}.`,
    'Review the request here:',
    params.reviewUrl,
  ].join('\n');
  const bodyText = `${requester} requested access to ${params.teamName} on ${params.organisationName}.`;
  const html = buildEmailHtml({
    theme,
    subject,
    heading: 'Access request received',
    body: bodyText,
    bodyHtml: `${escapeHtml(requester)} requested access to ${escapeHtml(params.teamName)} on ${escapeHtml(params.organisationName)}.`,
    buttonLabel: 'Review request',
    buttonUrl: params.reviewUrl,
    minutes: 0,
    notification: true,
  });

  return { subject, text, html };
}

export function buildAccountExistsTemplate(params: {
  link: string;
  theme?: Partial<EmailTheme>;
  locale?: EmailLocale;
}): EmailTemplate {
  return buildLoginLinkTemplate(params);
}

export function buildPasswordResetTemplate(params: { link: string; theme?: Partial<EmailTheme> }): EmailTemplate {
  const minutes = tokenTtlMinutes();
  const theme = resolveTheme(params.theme);

  const subject = 'Reset your password';
  const text = [
    'Reset your password',
    '',
    'If you requested a password reset, use this link:',
    params.link,
    '',
    `This link expires in ${minutes} minutes and can only be used once.`,
    '',
    'If you did not request this, you can ignore this email.',
  ].join('\n');

  const html = buildEmailHtml({
    theme,
    subject,
    heading: 'Reset your password',
    body: 'If you requested a password reset, click the button below.',
    buttonLabel: 'Reset password',
    buttonUrl: params.link,
    minutes,
  });

  return { subject, text, html };
}

export function buildIntegrationApprovedTemplate(params: {
  link: string;
  domain: string;
  ttlHours?: number;
  theme?: Partial<EmailTheme>;
}): EmailTemplate {
  const theme = resolveTheme(params.theme);
  const ttlHours = params.ttlHours ?? 24;
  const minutes = Math.max(1, Math.round(ttlHours * 60));
  const domain = params.domain;

  const subject = 'Your UnlikeOtherAuthenticator integration is approved';
  const text = [
    `Your integration for ${domain} has been approved.`,
    '',
    'Open this one-time link to copy your client_secret and client_hash:',
    params.link,
    '',
    `This link expires in ${ttlHours} hours and can only be used once.`,
    'The client secret is only displayed once — store it somewhere safe before leaving the page.',
    '',
    'If you did not expect this email, you can ignore it.',
  ].join('\n');

  const html = buildEmailHtml({
    theme,
    subject,
    heading: 'Integration approved',
    body:
      `Your integration for ${domain} has been approved. Open the one-time link below to copy your client_secret and client_hash. ` +
      'The secret is only displayed once — store it somewhere safe before leaving the page.',
    buttonLabel: 'Reveal client secret',
    buttonUrl: params.link,
    minutes,
    expiryLabel: `This link expires in ${ttlHours} hours and can only be used once.`,
  });

  return { subject, text, html };
}

export function buildIntegrationRequestNotificationTemplate(params: {
  domain: string;
  contactEmail: string;
  adminUrl: string;
  theme?: Partial<EmailTheme>;
}): EmailTemplate {
  const theme = resolveTheme(params.theme);
  const subject = `New integration request: ${params.domain}`;
  const text = [
    'New integration request pending review',
    '',
    `A partner at ${params.domain} has submitted a signed config JWT and is waiting for approval.`,
    '',
    `Domain: ${params.domain}`,
    `Contact: ${params.contactEmail}`,
    '',
    'Review it here:',
    params.adminUrl,
  ].join('\n');

  const html = buildEmailHtml({
    theme,
    subject,
    heading: 'New integration request',
    body: `A partner at ${params.domain} has submitted a signed config JWT and is waiting for approval. Contact: ${params.contactEmail}`,
    bodyHtml: `A partner at <strong>${escapeHtml(params.domain)}</strong> has submitted a signed config JWT and is waiting for approval.<br/>
                Contact: <strong>${escapeHtml(params.contactEmail)}</strong>`,
    buttonLabel: 'Review request',
    buttonUrl: params.adminUrl,
    minutes: 0,
    notification: true,
  });

  return { subject, text, html };
}

export function buildTwoFaResetTemplate(params: { link: string; theme?: Partial<EmailTheme> }): EmailTemplate {
  const minutes = tokenTtlMinutes();
  const theme = resolveTheme(params.theme);

  const subject = 'Reset two-factor authentication';
  const text = [
    'Reset two-factor authentication',
    '',
    'If you requested to reset two-factor authentication, use this link:',
    params.link,
    '',
    `This link expires in ${minutes} minutes and can only be used once.`,
    '',
    'If you did not request this, you can ignore this email.',
  ].join('\n');

  const html = buildEmailHtml({
    theme,
    subject,
    heading: 'Reset two-factor authentication',
    body: 'If you requested to reset two-factor authentication, click the button below.',
    buttonLabel: 'Reset two-factor authentication',
    buttonUrl: params.link,
    minutes,
  });

  return { subject, text, html };
}
