import { describe, expect, it } from 'vitest';

import { buildThemeFromConfig } from './theme-utils.js';

function config(colors: Record<string, string>, cssVars?: Record<string, string>) {
  return {
    ui_theme: {
      colors: {
        bg: '#ffffff',
        surface: '#f7f7f7',
        text: '#151917',
        muted: '#7b7169',
        primary: '#FFDF2C',
        primary_text: '#1B1B1B',
        border: '#e5e5e5',
        danger: '#c23b3b',
        danger_text: '#ffffff',
        ...colors,
      },
      radii: { card: '16px', button: '12px', input: '12px' },
      density: 'comfortable',
      typography: { font_family: 'sans', base_text_size: 'md' },
      button: { style: 'solid' },
      card: { style: 'bordered' },
      logo: { url: '', alt: 'Hugo' },
      ...(cssVars ? { css_vars: cssVars } : {}),
    },
  };
}

// HUGO-1815: a light brand primary (Hugo yellow) is fine as a button fill but unreadable as text on
// white, so text links read `--uoa-color-link`, which a client may set separately.
describe('--uoa-color-link', () => {
  it('uses colors.link when the client sets it', () => {
    const theme = buildThemeFromConfig(config({ link: '#1B1B1B' }));
    expect(theme.vars['--uoa-color-link']).toBe('#1B1B1B');
    expect(theme.vars['--uoa-color-primary']).toBe('#FFDF2C');
  });

  it('falls back to primary when colors.link is absent', () => {
    const theme = buildThemeFromConfig(config({}));
    expect(theme.vars['--uoa-color-link']).toBe('#FFDF2C');
  });

  it('falls back to a css_vars-overridden primary', () => {
    const theme = buildThemeFromConfig(config({}, { '--uoa-color-primary': '#2563eb' }));
    expect(theme.vars['--uoa-color-link']).toBe('#2563eb');
  });

  it('ignores an invalid colors.link and falls back to primary', () => {
    const theme = buildThemeFromConfig(config({ link: 'red;}body{x' }));
    expect(theme.vars['--uoa-color-link']).toBe('#FFDF2C');
  });
});
