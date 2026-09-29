import { describe, expect, it } from 'vitest';

import {
  buildAccessRequestNotificationTemplate,
  buildAccountExistsTemplate,
  buildIntegrationRequestNotificationTemplate,
  buildRegistrationLinkTemplate,
  buildLoginLinkTemplate,
  buildPasswordResetTemplate,
  buildTeamInviteTemplate,
  buildTwoFaResetTemplate,
  buildVerifyEmailTemplate,
  buildVerifyEmailSetPasswordTemplate,
} from '../../src/services/email.templates.js';
import { buildLoginCodeTemplate } from '../../src/services/email.templates.login-code.js';
import type { EmailLocale } from '../../src/services/email.templates.js';

describe('buildVerifyEmailSetPasswordTemplate', () => {
  it('includes subject, text, and html with the provided link', () => {
    const link =
      'https://auth.example.com/auth/email/link?token=t&config_url=https%3A%2F%2Fcfg.example.com%2Fconfig.jwt';
    const tpl = buildVerifyEmailSetPasswordTemplate({ link });
    const escapedLink = link.replaceAll('&', '&amp;');

    expect(tpl.subject).toBe('Your sign-in link');
    expect(tpl.text).toContain(link);
    expect(tpl.text).toContain('reach your account or finish signing up');
    expect(tpl.text).not.toContain('login-link');
    expect(tpl.text).not.toContain('verify-set-password');
    expect(tpl.text).toMatch(/good for 24 hours/i);
    expect(tpl.html).toMatch(/good for 24 hours/i);
    expect(tpl.text).toMatch(/pretend this never happened/i);
    expect(tpl.text).not.toMatch(/set your password/i);

    expect(tpl.html).toContain('get you in');
    expect(tpl.html).toContain('Continue');
    expect(tpl.html).toContain(`href="${escapedLink}"`);
    expect(tpl.html).not.toContain('login-link');
    expect(tpl.html).not.toContain('verify-set-password');
  });

  it('escapes links in HTML so special characters cannot break attributes', () => {
    const link = 'https://example.com/path?x=1&y=2';
    const tpl = buildVerifyEmailSetPasswordTemplate({ link });

    // `&` must be escaped in attributes and body text.
    expect(tpl.html).toContain('href="https://example.com/path?x=1&amp;y=2"');
    expect(tpl.html).toContain('https://example.com/path?x=1&amp;y=2');
    expect(tpl.html).not.toContain('href="https://example.com/path?x=1&y=2"');
  });
});

describe('buildVerifyEmailTemplate', () => {
  it('includes subject, text, and html with the provided link', () => {
    const link =
      'https://auth.example.com/auth/email/link?token=t&config_url=https%3A%2F%2Fcfg.example.com%2Fconfig.jwt';
    const tpl = buildVerifyEmailTemplate({ link });
    const escapedLink = link.replaceAll('&', '&amp;');

    expect(tpl.subject).toBe('Your sign-in link');
    expect(tpl.text).toContain(link);
    expect(tpl.text).toContain('reach your account or finish signing up');
    expect(tpl.text).toMatch(/good for 24 hours/i);
    expect(tpl.html).toMatch(/good for 24 hours/i);
    expect(tpl.text).toMatch(/pretend this never happened/i);
    expect(tpl.text).not.toContain('set your password');

    expect(tpl.html).toContain('get you in');
    expect(tpl.html).toContain('Continue');
    expect(tpl.html).toContain(`href="${escapedLink}"`);
    expect(tpl.html).not.toContain('set your password');
  });

  it('escapes links in HTML so special characters cannot break attributes', () => {
    const link = 'https://example.com/path?x=1&y=2';
    const tpl = buildVerifyEmailTemplate({ link });

    expect(tpl.html).toContain('href="https://example.com/path?x=1&amp;y=2"');
    expect(tpl.html).toContain('https://example.com/path?x=1&amp;y=2');
    expect(tpl.html).not.toContain('href="https://example.com/path?x=1&y=2"');
  });
});

describe('buildPasswordResetTemplate', () => {
  it('includes subject, text, and html with the provided link', () => {
    const link =
      'https://auth.example.com/auth/email/reset-password?token=t&config_url=https%3A%2F%2Fcfg.example.com%2Fconfig.jwt';
    const tpl = buildPasswordResetTemplate({ link });
    const escapedLink = link.replaceAll('&', '&amp;');

    expect(tpl.subject).toBe('Reset your password');
    expect(tpl.text).toContain(link);
    expect(tpl.text).toMatch(/expires in 30 minutes/i);
    expect(tpl.text).toMatch(/ignore this email/i);
    expect(tpl.text).toMatch(/if you requested a password reset/i);

    expect(tpl.html).toContain('Reset your password');
    expect(tpl.html).toContain('Reset password');
    expect(tpl.html).toContain(`href="${escapedLink}"`);
  });

  it('escapes links in HTML so special characters cannot break attributes', () => {
    const link = 'https://example.com/path?x=1&y=2';
    const tpl = buildPasswordResetTemplate({ link });

    // `&` must be escaped in attributes and body text.
    expect(tpl.html).toContain('href="https://example.com/path?x=1&amp;y=2"');
    expect(tpl.html).toContain('https://example.com/path?x=1&amp;y=2');
    expect(tpl.html).not.toContain('href="https://example.com/path?x=1&y=2"');
  });
});

describe('buildLoginLinkTemplate', () => {
  it('includes subject, text, and html with the provided link', () => {
    const link =
      'https://auth.example.com/auth/email/link?token=t&config_url=https%3A%2F%2Fcfg.example.com%2Fconfig.jwt';
    const tpl = buildLoginLinkTemplate({ link });
    const escapedLink = link.replaceAll('&', '&amp;');

    expect(tpl.subject).toBe('Your sign-in link');
    expect(tpl.text).toContain(link);
    expect(tpl.text).toContain('reach your account or finish signing up');
    expect(tpl.text).not.toContain('login-link');
    expect(tpl.text).not.toContain('verify-set-password');
    expect(tpl.text).toMatch(/good for 30 minutes/i);
    expect(tpl.html).toMatch(/good for 30 minutes/i);
    expect(tpl.text).toMatch(/pretend this never happened/i);

    expect(tpl.html).toContain('get you in');
    expect(tpl.html).toContain('Continue');
    expect(tpl.html).toContain(`href="${escapedLink}"`);
    expect(tpl.html).not.toContain('login-link');
    expect(tpl.html).not.toContain('verify-set-password');
  });

  it('escapes links in HTML so special characters cannot break attributes', () => {
    const link = 'https://example.com/path?x=1&y=2';
    const tpl = buildLoginLinkTemplate({ link });

    // `&` must be escaped in attributes and body text.
    expect(tpl.html).toContain('href="https://example.com/path?x=1&amp;y=2"');
    expect(tpl.html).toContain('https://example.com/path?x=1&amp;y=2');
    expect(tpl.html).not.toContain('href="https://example.com/path?x=1&y=2"');
  });
});

describe('registration link template aliases', () => {
  it('uses one neutral 24-hour template for new-user and existing-user registration emails', () => {
    const link =
      'https://auth.example.com/auth/email/link?token=t&config_url=https%3A%2F%2Fcfg.example.com%2Fconfig.jwt';
    const neutral = buildRegistrationLinkTemplate({ link });

    expect(buildVerifyEmailSetPasswordTemplate({ link })).toEqual(neutral);
    expect(buildVerifyEmailTemplate({ link })).toEqual(neutral);
    expect(buildAccountExistsTemplate({ link })).toEqual(neutral);
    expect(neutral.subject).toBe('Your sign-in link');
    expect(neutral.text).toMatch(/good for 24 hours/i);
    expect(buildLoginLinkTemplate({ link }).text).toMatch(/good for 30 minutes/i);
    expect(neutral.text).not.toMatch(/already have an account|verify your email/i);
    expect(neutral.html).not.toMatch(/already have an account|reset password/i);
  });
});

describe('sign-in email localization (HUGO-553)', () => {
  const link =
    'https://auth.example.com/auth/email/link?token=t&config_url=https%3A%2F%2Fcfg.example.com%2Fconfig.jwt';

  it('uses English Hugo-voice copy by default', () => {
    const tpl = buildRegistrationLinkTemplate({ link });

    expect(tpl.subject).toBe('Your sign-in link');
    expect(tpl.html).toContain('<html lang="en">');
    expect(tpl.html).toContain('get you in');
    expect(tpl.html).toContain('reach your account or finish signing up');
    expect(tpl.html).toContain('Continue');
    expect(tpl.text).toMatch(/good for 24 hours/i);
    expect(tpl.html).toMatch(/good for 24 hours/i);
    expect(tpl.text).toMatch(/pretend this never happened/i);
  });

  it('renders Czech copy when locale is cs', () => {
    const tpl = buildRegistrationLinkTemplate({ link, locale: 'cs' });

    expect(tpl.subject).toBe('Tvůj přihlašovací odkaz');
    expect(tpl.html).toContain('<html lang="cs">');
    expect(tpl.html).toContain('Pojďme tě přihlásit');
    expect(tpl.html).toContain('dokončíš registraci');
    expect(tpl.html).toContain('Pokračovat');
    expect(tpl.text).toContain('Pojďme tě přihlásit');
    expect(tpl.text).toMatch(/odkaz platí 24 hodin/);
    expect(tpl.html).toMatch(/odkaz platí 24 hodin/);
    // HUGO-1815: informal address (tykání) throughout the Czech email.
    expect(tpl.html).not.toMatch(/Váš|vás|Klikněte|Zkopírujte|zapomeňte/);
    // No leftover English copy in the Czech email.
    expect(tpl.html).not.toContain('get you in');
    expect(tpl.html).not.toMatch(/good for 24 hours/i);
  });

  it('renders the exact shorter lifetime for a standalone Czech login link', () => {
    const tpl = buildLoginLinkTemplate({ link, locale: 'cs' });

    expect(tpl.text).toContain('odkaz platí 30 minut');
    expect(tpl.html).toContain('odkaz platí 30 minut');
    expect(tpl.text).not.toContain('24 hodin');
  });

  it('falls back to English for an unsupported locale', () => {
    const tpl = buildRegistrationLinkTemplate({ link, locale: 'de' as EmailLocale });

    expect(tpl.subject).toBe('Your sign-in link');
    expect(tpl.html).toContain('get you in');
  });
});

describe('buildTeamInviteTemplate', () => {
  it('includes the invite context and action link', () => {
    const link =
      'https://auth.example.com/auth/email/link?token=t&config_url=https%3A%2F%2Fcfg.example.com%2Fconfig.jwt';
    const tpl = buildTeamInviteTemplate({
      link,
      organisationName: 'Acme',
      teamName: 'Core Team',
      inviteeName: 'Taylor',
      trackingPixelUrl: 'https://auth.example.com/auth/email/team-invite-open/invite-1.gif',
    });
    const escapedLink = link.replaceAll('&', '&amp;');

    expect(tpl.subject).toBe('You have been invited to join Core Team');
    expect(tpl.text).toContain('Taylor, you have been invited to join the Core Team team on Acme.');
    expect(tpl.text).toContain(link);
    expect(tpl.text).toMatch(/accept the invitation/i);

    expect(tpl.html).toContain('Join Core Team');
    expect(tpl.html).toContain('Accept invitation');
    expect(tpl.html).toContain(`href="${escapedLink}"`);
    expect(tpl.html).toContain('team-invite-open/invite-1.gif');
  });
});

describe('buildAccessRequestNotificationTemplate', () => {
  it('includes requester context and the admin review link without token-expiry copy', () => {
    const reviewUrl = 'https://admin.example.com/team-access?request=123&team=core';
    const tpl = buildAccessRequestNotificationTemplate({
      reviewUrl,
      requesterEmail: 'alex@example.com',
      requesterName: 'Alex Example',
      organisationName: 'Acme',
      teamName: 'Core Team',
    });

    expect(tpl.subject).toBe('Alex Example <alex@example.com> requested access to Core Team');
    expect(tpl.text).toContain('Access request received');
    expect(tpl.text).toContain(reviewUrl);
    expect(tpl.text).not.toMatch(/expires in 30 minutes/i);
    expect(tpl.html).toContain('Review request');
    expect(tpl.html).toContain('Alex Example &lt;alex@example.com&gt;');
    expect(tpl.html).toContain(
      'href="https://admin.example.com/team-access?request=123&amp;team=core"',
    );
  });
});

describe('buildTwoFaResetTemplate', () => {
  it('includes subject, text, and html with the provided link', () => {
    const link =
      'https://auth.example.com/auth/email/twofa-reset?token=t&config_url=https%3A%2F%2Fcfg.example.com%2Fconfig.jwt';
    const tpl = buildTwoFaResetTemplate({ link });
    const escapedLink = link.replaceAll('&', '&amp;');

    expect(tpl.subject).toBe('Reset two-factor authentication');
    expect(tpl.text).toContain(link);
    expect(tpl.text).toMatch(/expires in 30 minutes/i);
    expect(tpl.text).toMatch(/ignore this email/i);
    expect(tpl.text).toMatch(/if you requested to reset two-factor authentication/i);

    expect(tpl.html).toContain('Reset two-factor authentication');
    expect(tpl.html).toContain(`href="${escapedLink}"`);
  });

  it('escapes links in HTML so special characters cannot break attributes', () => {
    const link = 'https://example.com/path?x=1&y=2';
    const tpl = buildTwoFaResetTemplate({ link });

    // `&` must be escaped in attributes and body text.
    expect(tpl.html).toContain('href="https://example.com/path?x=1&amp;y=2"');
    expect(tpl.html).toContain('https://example.com/path?x=1&amp;y=2');
    expect(tpl.html).not.toContain('href="https://example.com/path?x=1&y=2"');
  });
});

describe('buildIntegrationRequestNotificationTemplate', () => {
  it('renders domain, contact email, and admin URL in subject/text/html', () => {
    const tpl = buildIntegrationRequestNotificationTemplate({
      domain: 'api.partner.example',
      contactEmail: 'ops@partner.example',
      adminUrl: 'https://auth.example/admin/integrations?focus=abc123',
    });

    expect(tpl.subject).toBe('New integration request: api.partner.example');
    expect(tpl.text).toContain('api.partner.example');
    expect(tpl.text).toContain('ops@partner.example');
    expect(tpl.text).toContain('https://auth.example/admin/integrations?focus=abc123');

    expect(tpl.html).toContain('New integration request');
    expect(tpl.html).toContain('api.partner.example');
    expect(tpl.html).toContain('ops@partner.example');
    expect(tpl.html).toContain('href="https://auth.example/admin/integrations?focus=abc123"');
  });

  it('escapes attacker-controlled domain and contact email in HTML', () => {
    const tpl = buildIntegrationRequestNotificationTemplate({
      domain: 'evil"><script>alert(1)</script>',
      contactEmail: 'x"@y<script>',
      adminUrl: 'https://auth.example/admin/integrations',
    });

    expect(tpl.html).not.toContain('<script>alert(1)</script>');
    expect(tpl.html).toContain('evil&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(tpl.html).toContain('x&quot;@y&lt;script&gt;');
  });
});

describe('account email localization (HUGO-1815)', () => {
  const link = 'https://auth.example.com/auth/email/x?token=t&ui_locales=cs';

  it('renders the Czech password reset email with informal address', () => {
    const tpl = buildPasswordResetTemplate({ link, locale: 'cs' });

    expect(tpl.subject).toBe('Obnovení hesla');
    expect(tpl.html).toContain('<html lang="cs">');
    expect(tpl.html).toContain('Obnov si heslo');
    expect(tpl.html).toContain('Obnovit heslo');
    expect(tpl.text).toContain('Pokud jsi žádal(a) o obnovení hesla, použij tento odkaz:');
    expect(tpl.text).toContain('Odkaz platí 30 minut a použít ho můžeš jen jednou.');
    expect(tpl.html).toContain('Pokud tlačítko nefunguje, zkopíruj tuto adresu do prohlížeče:');
    expect(tpl.html).toContain('tenhle e-mail klidně ignoruj');
    expect(tpl.html).not.toContain('This link expires');
    expect(tpl.html).not.toContain('If you did not request');
  });

  it('renders the Czech 2FA reset email', () => {
    const tpl = buildTwoFaResetTemplate({ link, locale: 'cs' });

    expect(tpl.subject).toBe('Obnovení dvoufázového ověření');
    expect(tpl.html).toContain('<html lang="cs">');
    expect(tpl.html).toContain('Obnovit dvoufázové ověření');
    expect(tpl.text).toContain('použij tento odkaz:');
    expect(tpl.html).not.toContain('If you requested');
  });

  it('renders the Czech login code email', () => {
    const tpl = buildLoginCodeTemplate({ code: '123456', locale: 'cs' });

    expect(tpl.subject).toBe('Tvůj přihlašovací kód');
    expect(tpl.html).toContain('<html lang="cs">');
    expect(tpl.text).toContain('Pro přihlášení zadej tento kód: 123456');
    expect(tpl.html).toContain('Kód platí');
    expect(tpl.html).not.toContain('This code expires');
  });

  it('keeps English copy unchanged when no locale (or an unsupported one) is given', () => {
    const pw = buildPasswordResetTemplate({ link });
    expect(pw.subject).toBe('Reset your password');
    expect(pw.html).toContain('<html lang="en">');
    expect(pw.text).toContain('If you requested a password reset, use this link:');
    expect(pw.html).toContain('This link expires in 30 minutes and can only be used once.');
    expect(pw.html).toContain(
      'If the button does not work, copy and paste this URL into your browser:',
    );

    const twofa = buildTwoFaResetTemplate({ link, locale: 'de' as EmailLocale });
    expect(twofa.subject).toBe('Reset two-factor authentication');

    const code = buildLoginCodeTemplate({ code: '123456' });
    expect(code.subject).toBe('Your sign-in code');
    expect(code.html).toContain('<html lang="en">');
    expect(code.text).toContain('Enter this code to sign in: 123456');
  });
});
