import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { RegisterPage } from './RegisterPage.js';
import { RegisterForm } from '../components/form/RegisterForm.js';
import { PopupProvider } from '../hooks/use-popup.js';
import { I18nProvider } from '../i18n/I18nProvider.js';
import { ThemeProvider } from '../theme/ThemeProvider.js';

// HUGO-1858: a client that styles "create account" as a secondary button (Hugo) gets
// "back to sign in" as a matching filled-secondary button right under the register submit,
// in the form AND on the "instructions sent" confirmation; every other client keeps the
// link under the social buttons.

type Style = 'link' | 'secondary';

// The filled-secondary class only exists when colors.secondary is set (theme-utils).
const SECONDARY_FILL = 'bg-[var(--uoa-color-secondary)]';
const BACK = { cs: 'Zpět na přihlášení', en: 'Back to sign in' } as const;

function configWith(createAccount: Style, language: string) {
  return {
    ui_theme: {
      colors: {
        bg: '#f8fafc',
        surface: '#ffffff',
        text: '#0f172a',
        muted: '#475569',
        primary: '#2563eb',
        primary_text: '#ffffff',
        secondary: '#e2ddd5',
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

function render(node: React.ReactNode, createAccount: Style, language = 'cs'): string {
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
          {node}
        </PopupProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
}

/** Every <button> in document order, as { type, className, text }. */
function buttons(html: string): { type: string; className: string; text: string }[] {
  return [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].map(([, attrs, inner]) => ({
    type: /type="([^"]*)"/.exec(attrs)?.[1] ?? '',
    className: /class="([^"]*)"/.exec(attrs)?.[1] ?? '',
    text: inner.replace(/<[^>]*>/g, '').trim(),
  }));
}

describe('RegisterPage submit label', () => {
  it.each([
    ['cs', 'Registrovat'],
    ['en', 'Register'],
    ['es', 'Registrarse'],
  ])('labels the %s submit "%s"', (language, label) => {
    const submit = buttons(render(<RegisterPage />, 'link', language)).find(
      (b) => b.type === 'submit',
    );
    expect(submit?.text).toBe(label);
  });
});

describe('RegisterPage back to sign in — secondary style', () => {
  it('is a filled-secondary button directly after the submit, before the social buttons', () => {
    const all = buttons(render(<RegisterPage />, 'secondary'));
    const submitAt = all.findIndex((b) => b.type === 'submit');
    expect(all[submitAt + 1]).toMatchObject({ type: 'button', text: BACK.cs });
    expect(all[submitAt + 1].className).toContain(SECONDARY_FILL);
    expect(all.filter((b) => b.text === BACK.cs)).toHaveLength(1);
  });

  it('stays on the "instructions sent" confirmation', () => {
    const html = render(<RegisterForm initialSubmitted />, 'secondary');
    expect(html).toContain('role="status"');
    const back = buttons(html).filter((b) => b.text === BACK.cs);
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ type: 'button' });
    expect(back[0].className).toContain(SECONDARY_FILL);
  });
});

describe('RegisterPage back to sign in — default link style', () => {
  it('stays a single link after the social buttons, not a button in the form', () => {
    const html = render(<RegisterPage />, 'link', 'en');
    const all = buttons(html);
    const back = all.filter((b) => b.text === BACK.en);
    expect(back).toHaveLength(1);
    expect(back[0].className).not.toContain(SECONDARY_FILL);
    expect(all[all.length - 1].text).toBe(BACK.en);
    const form = html.slice(html.indexOf('<form'), html.indexOf('</form>'));
    expect(form).not.toContain(BACK.en);
  });

  it('adds no button to the confirmation (the page link remains the way back)', () => {
    const html = render(<RegisterForm initialSubmitted />, 'link', 'en');
    expect(html).toContain('role="status"');
    expect(buttons(html)).toHaveLength(0);
  });
});
