import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ForwardButtons } from './ForwardButtons.js';
import { PopupProvider } from '../../hooks/use-popup.js';
import { I18nProvider } from '../../i18n/I18nProvider.js';
import { ThemeProvider } from '../../theme/ThemeProvider.js';

// ForwardButtons renders partner-hosted login options (config.forward_auth_methods)
// as plain <a> links that top-level-navigate the authenticator window to the
// partner's URL — e.g. Hugo's "Login with Piano" forwarding to /login?sso=piano.

const BASE_THEME = {
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
    button: { style: 'solid' },
    card: { style: 'bordered' },
    logo: { url: '', alt: 'Logo' },
  },
  language_config: 'en',
};

function renderForwardButtons(config: Record<string, unknown>): string {
  return renderToString(
    <ThemeProvider config={config} configUrl="">
      <I18nProvider config={config} configUrl="">
        <PopupProvider configUrl="" config={config} initialSearch="">
          <ForwardButtons />
        </PopupProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
}

describe('ForwardButtons', () => {
  it('renders a forward link for each configured method', () => {
    const html = renderForwardButtons({
      ...BASE_THEME,
      forward_auth_methods: [
        { id: 'piano', label: 'Piano', url: 'https://admin.hugopos.eu/login?sso=piano' },
      ],
    });

    expect(html).toContain('href="https://admin.hugopos.eu/login?sso=piano"');
    expect(html).toContain('Piano');
  });

  it('renders no forward link when no forward methods are configured', () => {
    // ThemeProvider always emits a theme wrapper; ForwardButtons itself returns
    // null, so there must be no anchor/href in the output.
    const html = renderForwardButtons({ ...BASE_THEME });

    expect(html).not.toContain('<a ');
    expect(html).not.toContain('href=');
  });

  it('skips entries whose url is not an http(s) URL', () => {
    const html = renderForwardButtons({
      ...BASE_THEME,
      forward_auth_methods: [
        { id: 'evil', label: 'Evil', url: 'javascript:alert(1)' },
        { id: 'piano', label: 'Piano', url: 'https://admin.hugopos.eu/login?sso=piano' },
      ],
    });

    expect(html).not.toContain('javascript:');
    expect(html).toContain('href="https://admin.hugopos.eu/login?sso=piano"');
  });
});
