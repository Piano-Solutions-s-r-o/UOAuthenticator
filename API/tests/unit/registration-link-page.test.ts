import { describe, expect, it } from 'vitest';

import { renderRegistrationLinkPage } from '../../src/services/registration-link-page.service.js';

describe('registration link confirmation page', () => {
  it('defaults to English and keeps the nonce, fragment removal and no third-party assets', () => {
    const html = renderRegistrationLinkPage('nonce-123');
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<title>Confirm your email</title>');
    expect(html).toContain('>Verify email address</button>');
    expect(html).toContain('<script nonce="nonce-123">');
    expect(html).toContain('history.replaceState');
    expect(html).toContain('Your original registration screen will continue automatically. This page has not signed you in.');
    expect(html).toContain('This link has expired or is no longer valid. Request a new email from the registration screen.');
    expect(html).not.toContain('<img');
    expect(html).not.toMatch(/https?:\/\//);
  });

  it('renders informal Czech for a Czech request, including every recovery message', () => {
    const html = renderRegistrationLinkPage('nonce-123', 'cs');
    expect(html).toContain('<html lang="cs">');
    expect(html).toContain('<title>Potvrď svůj e-mail</title>');
    expect(html).toContain('Po potvrzení bude registrace pokračovat v prohlížeči, kde začala. Potvrzuj jen registraci, kterou zakládáš ty.');
    expect(html).toContain('>Ověřit e-mail</button>');
    for (const message of [
      'Ověřuji…',
      'E-mail je ověřený',
      'Tvoje e-mailová adresa je potvrzená.',
      'Registrace v původním okně teď sama pokračuje. Toto zařízení se nepřihlásilo.',
      'Odkaz vypršel nebo už neplatí. Nový e-mail si nech poslat z okna registrace.',
      'Tenhle odkaz nejde použít. Nový e-mail si nech poslat z okna registrace.',
      'Nepodařilo se spojit se serverem. Zkontroluj připojení a zkus to znovu.',
      'Odkaz teď nejde ověřit. Zkus to za chvíli znovu.',
    ]) expect(html).toContain(message);
    expect(html).not.toContain('Verify email address');
    expect(html).not.toContain('přihlášený');
  });

  it('only a transport, 429 or 5xx failure keeps the retry; every other answer is final', () => {
    const script = renderRegistrationLinkPage('n').split('<script')[1] ?? '';
    expect(script).toContain('response.status === 429 || response.status >= 500');
    expect(script).toContain('finish(copy.rejected)');
    expect(script).toContain("credentials: 'same-origin'");
  });
});
