import { describe, expect, it, vi } from 'vitest';

import { REGISTRATION_EMAIL_TOKEN_TTL_MS } from '../../src/config/constants.js';
import { getEnv } from '../../src/config/env.js';
import { registrationTokenTtlHours } from '../../src/services/email.registration-copy.js';
import { safeEmailLog } from '../../src/services/email.providers.js';
import { buildRegistrationVerificationTemplate } from '../../src/services/email.templates.registration.js';
import { REGISTRATION_TTL_MS } from '../../src/services/registration-credentials.js';

const link = 'https://auth.example/registration#secret';

const email = 'person@example.com';

describe('registration verification email', () => {
  it('shows the address, a prominent link and the same spaced code in HTML and text', () => {
    const hours = registrationTokenTtlHours();
    const template = buildRegistrationVerificationTemplate({ email, code: 'AB3K7M', link });
    expect(template.subject).toBe('Finish your Hugo registration');
    expect(template.html).toContain('<html lang="en">');
    expect(template.html).toContain('Finish your registration</h1>');
    expect(template.html).toContain('Continue registration</a>');
    expect(template.html).toContain('font-size:32px;font-weight:700;letter-spacing:8px');
    expect(template.text).toContain('AB3K7M'); expect(template.html).toContain('AB3K7M');
    for (const body of [template.text, template.html]) {
      expect(body).toContain(`You are registering an account for ${email}.`);
      expect(body).toContain(`The link and code are valid for ${hours} hours.`);
    }
  });

  it('is the exact Czech copy for a Czech request and keeps the button, link and large code', () => {
    const template = buildRegistrationVerificationTemplate({ email, code: 'AB3K7M', link, locale: 'cs' });
    expect(template.subject).toBe('Dokonči registraci do Huga');
    expect(template.html).toContain('<html lang="cs">');
    expect(template.html).toContain('Dokonči registraci</h1>');
    expect(template.html).toContain('Pokračovat v registraci</a>');
    expect(template.html).toContain(`href="${link}"`);
    expect(template.html).toContain('Nebo zadej v Hugu kód:');
    expect(template.html).toContain('font-size:32px;font-weight:700;letter-spacing:8px');
    expect(template.text).toContain('Nebo zadej v Hugu kód: AB3K7M');
    expect(template.text).toContain(link);
    for (const body of [template.text, template.html]) {
      expect(body).toContain(`Registruješ účet pro ${email}.`);
      expect(body).toContain(`Odkaz i kód platí ${registrationTokenTtlHours()} hodin.`);
      expect(body).toContain('Pokud o registraci nevíš, na nic neklikej a e-mail ignoruj.');
    }
  });

  it.each(['en', 'cs'] as const)('says nothing about windows, devices or going back (%s)', (locale) => {
    const template = buildRegistrationVerificationTemplate({ email, code: 'AB3K7M', link, locale });
    for (const body of [template.text, template.subject, template.html.replace(/<[^>]*>/g, ' ')]) {
      expect(body).not.toMatch(/\bwindow\b|\bdevice\b|\boknu?\b|okn[aě]\b|zařízení/i);
    }
  });

  it('escapes the address in the HTML', () => {
    const template = buildRegistrationVerificationTemplate({ email: 'a<b>@example.com', code: 'AB3K7M', link });
    expect(template.html).not.toContain('a<b>@example.com');
    expect(template.html).toContain('a&lt;b&gt;@example.com');
  });

  it('uses the same theme and logo plumbing as the other emails', () => {
    const template = buildRegistrationVerificationTemplate({
      email, code: 'AB3K7M', link, locale: 'cs',
      theme: { bg: '#101010', primary: '#ff0066', logoUrl: 'https://client.example/logo.png', logoAlt: 'Hugo' },
    });
    expect(template.html).toContain('<img src="https://client.example/logo.png" alt="Hugo"');
    expect(template.html).toContain('background-color:#ff0066');
    expect(template.html).toContain('background-color:#101010');
  });

  it('states a validity that is the registration email lifetime, in hours', () => {
    expect(REGISTRATION_TTL_MS).toBe(REGISTRATION_EMAIL_TOKEN_TTL_MS);
    expect(registrationTokenTtlHours() * 60 * 60 * 1000).toBe(REGISTRATION_TTL_MS);
  });

  it('never logs registration email content, including in development', () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    safeEmailLog({ ...getEnv(), NODE_ENV: 'development' }, {
      to: 'person@example.com', subject: 'Verify your email address', text: 'SECRET-CODE', html: 'SECRET-TOKEN', suppressContentLog: true,
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('SECRET');
    log.mockRestore();
  });
});
