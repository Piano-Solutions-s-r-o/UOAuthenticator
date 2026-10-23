import { describe, expect, it, vi } from 'vitest';

import { REGISTRATION_EMAIL_TOKEN_TTL_MS } from '../../src/config/constants.js';
import { getEnv } from '../../src/config/env.js';
import { registrationTokenTtlHours } from '../../src/services/email.registration-copy.js';
import { safeEmailLog } from '../../src/services/email.providers.js';
import { buildRegistrationVerificationTemplate } from '../../src/services/email.templates.registration.js';
import { REGISTRATION_TTL_MS } from '../../src/services/registration-credentials.js';

const link = 'https://auth.example/registration#secret';

describe('registration verification email', () => {
  it('shows one neutral subject, a prominent link and the same spaced code in HTML and text', () => {
    const hours = registrationTokenTtlHours();
    const template = buildRegistrationVerificationTemplate({ code: 'AB3K7M', link });
    expect(template.subject).toBe('Verify your email address');
    expect(template.html).toContain('<html lang="en">');
    expect(template.html).toContain('Confirm your email');
    expect(template.html).toContain('Verify email address</a>');
    expect(template.html).toContain('font-size:32px;font-weight:700;letter-spacing:8px');
    expect(template.text).toContain('AB3K7M'); expect(template.html).toContain('AB3K7M');
    expect(template.text).toContain(`expire in ${hours} hours`); expect(template.html).toContain(`expire in ${hours} hours`);
    expect(template.text).toContain('another device does not sign');
  });

  it('is written in informal Czech for a Czech request and keeps the button, link and large code', () => {
    const template = buildRegistrationVerificationTemplate({ code: 'AB3K7M', link, locale: 'cs' });
    expect(template.subject).toBe('Ověř svůj e-mail');
    expect(template.html).toContain('<html lang="cs">');
    expect(template.html).toContain('Ověř svůj e-mail</h1>');
    expect(template.html).toContain('Klikni na tlačítko na jakémkoli zařízení, nebo opiš kód do okna, kde registrace začala.');
    expect(template.html).toContain('Ověřit e-mail</a>');
    expect(template.html).toContain(`href="${link}"`);
    expect(template.html).toContain('Nebo zadej tento kód:');
    expect(template.html).toContain('font-size:32px;font-weight:700;letter-spacing:8px');
    expect(template.text).toContain('Nebo zadej tento kód: AB3K7M');
    expect(template.text).toContain(link);
    for (const body of [template.text, template.html]) {
      expect(body).toContain(`Odkaz i kód platí ${registrationTokenTtlHours()} hodin. Odkaz jde použít jen jednou.`);
      expect(body).toContain('Když odkaz otevřeš na jiném zařízení, registrace pokračuje v okně, kde začala. Toto zařízení se nepřihlásí.');
      expect(body).toContain('Pokud o registraci nevíš, e-mail klidně ignoruj.');
    }
  });

  it('uses the same theme and logo plumbing as the other emails', () => {
    const template = buildRegistrationVerificationTemplate({
      code: 'AB3K7M', link, locale: 'cs',
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
