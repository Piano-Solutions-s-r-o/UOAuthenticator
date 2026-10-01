import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { RegisterPage } from './RegisterPage.js';
import { PopupProvider } from '../hooks/use-popup.js';
import { I18nProvider } from '../i18n/I18nProvider.js';
import { ThemeProvider } from '../theme/ThemeProvider.js';

// HUGO-1858: a client that styles "create account" as a secondary button (Hugo) gets
// "back to sign in" as a matching button right under the register submit; every other
// client keeps the link under the social buttons.

function configWith(createAccount: 'link' | 'secondary', language: string) {
  return {
    ui_theme: {
      colors: {
        bg: '#f8fafc',
        surface: '#ffffff',
        text: '#0f172a',
        muted: '#475569',
        primary: '#2563eb',
        primary_text: '#ffffff',
        border: '#e2e8f0',
        danger: '#dc2626',
        danger_text: '#ffffff',
      },
      radii: { card: '16px', button: '12px', input: '12px' },
      density: 'comfortable',
      typography: { font_family: 'sans', base_text_size: 'md' },
      button: { style: 'solid', create_account: createAccount },
      card: { style: 'bordered' },
      logo: { url: '', alt: 'Logo' },
    },
    language_config: language,
  };
}

function renderRegister(createAccount: 'link' | 'secondary', language = 'cs'): string {
  const config = configWith(createAccount, language);
  return renderToString(
    <ThemeProvider config={config} configUrl="">
      <I18nProvider config={config} configUrl="">
        <PopupProvider
          configUrl=""
          config={config}
          initialSearch="?config_url=https%3A%2F%2Fclient.example.com%2Fauth-config"
          initialView="register"
        >
          <RegisterPage />
        </PopupProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
}

describe('RegisterPage call to action', () => {
  it('labels the Czech submit "Registrovat"', () => {
    expect(renderRegister('secondary')).toContain('>Registrovat</button>');
  });

  it('puts "back to sign in" as a button directly under the submit for a secondary style', () => {
    const html = renderRegister('secondary');
    const form = html.slice(html.indexOf('<form'), html.indexOf('</form>'));
    expect(form).toContain('type="submit"');
    expect(form).toContain('Zpět na přihlášení');
    // Exactly one way back: no link left under the social buttons.
    expect(html.split('Zpět na přihlášení')).toHaveLength(2);
  });

  it('keeps "back to sign in" as a link below the form for the default link style', () => {
    const html = renderRegister('link');
    const form = html.slice(html.indexOf('<form'), html.indexOf('</form>'));
    expect(form).not.toContain('Zpět na přihlášení');
    expect(html.split('Zpět na přihlášení')).toHaveLength(2);
  });

  it('labels the English submit "Register"', () => {
    expect(renderRegister('link', 'en')).toContain('>Register</button>');
  });
});
