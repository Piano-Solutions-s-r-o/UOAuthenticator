import { describe, expect, it } from 'vitest';

import { registrationLinkPageCsp, renderRegistrationLinkPage } from '../../src/services/registration-link-page.service.js';

describe('registration link page', () => {
  it('defaults to English and keeps the nonce, fragment removal and no third-party assets', () => {
    const html = renderRegistrationLinkPage('nonce-123');
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<title>Opening Hugo…</title>');
    expect(html).toContain('<script nonce="nonce-123">');
    expect(html).toContain('history.replaceState');
    expect(html).not.toContain('<img');
    expect(html).not.toMatch(/https?:\/\//);
  });

  it('renders the Czech copy for a Czech request, including every outcome', () => {
    const html = renderRegistrationLinkPage('nonce-123', 'cs');
    expect(html).toContain('<html lang="cs">');
    expect(html).toContain('<title>Otevírám Hugo…</title>');
    for (const message of [
      'Otevírám Hugo…', 'Registrace je hotová.', 'Přihlásit se', 'Odkaz už neplatí',
      'Začít registraci znovu', 'Nepodařilo se spojit se serverem.', 'Zkusit znovu',
    ]) expect(html).toContain(message);
    expect(html).not.toContain('Opening Hugo');
  });

  it('never asks anyone to confirm or to go anywhere', () => {
    for (const locale of ['en', 'cs'] as const) {
      const html = renderRegistrationLinkPage('n', locale);
      const copy = /const copy = (\{.*\});/.exec(html)?.[1] ?? '';
      expect(Object.keys(JSON.parse(copy))).toHaveLength(7);
      expect(copy).not.toMatch(/window|okn[oa]|zařízení|device|confirm|potvr/i);
      expect(html).not.toContain('<form');
    }
  });

  it('posts at once, follows a continue, and keeps a retry only for what a retry can fix', () => {
    const script = renderRegistrationLinkPage('n').split('<script')[1] ?? '';
    expect(script).toContain("result.status === 'continue') location.replace(result.next)");
    expect(script).toContain('response.status === 429 || response.status >= 500');
    expect(script).toContain("credentials: 'same-origin'");
    expect(script).toMatch(/\n {2}open\(\);\n/);
  });

  it('gives the anchors the button style and hides them until an outcome needs one', () => {
    const html = renderRegistrationLinkPage('n');
    const style = (id: string) => new RegExp(`id="${id}"[^>]*style="([^"]*)"`).exec(html)?.[1];
    expect(style('next')).toBe(style('retry'));
    expect(style('next')).toContain('display:none');
  });

  it('never renders a script without a usable nonce', () => {
    for (const bad of ['', 'undefined"', 'a b', '"><script>']) {
      expect(() => renderRegistrationLinkPage(bad)).toThrow('A CSP nonce is required');
    }
  });

  it('allows exactly its own nonce-bearing script, this origin for the call and nothing else', () => {
    expect(registrationLinkPageCsp('abc123')).toBe(
      "default-src 'none'; script-src 'nonce-abc123'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
  });
});
