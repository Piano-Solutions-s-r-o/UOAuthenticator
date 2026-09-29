import { describe, expect, it } from 'vitest';

import { buildThemeClassNames, buildThemeFromConfig } from './theme-utils.js';

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

describe('button.font_weight (HUGO-1815)', () => {
  function withButton(button: Record<string, unknown>) {
    const c = config({});
    return { ui_theme: { ...c.ui_theme, button } };
  }

  it('defaults to medium when absent', () => {
    const theme = buildThemeFromConfig(withButton({ style: 'solid' }));
    expect(buildThemeClassNames(theme).buttonPrimary).toContain('font-medium');
  });

  it('applies semibold to primary and secondary buttons', () => {
    const names = buildThemeClassNames(buildThemeFromConfig(withButton({ style: 'solid', font_weight: 'semibold' })));
    expect(names.buttonPrimary).toContain('font-semibold');
    expect(names.buttonSecondary).toContain('font-semibold');
    expect(names.buttonPrimary).not.toContain('font-medium');
  });

  it('rejects an unknown weight like any other invalid theme value', () => {
    expect(() => buildThemeFromConfig(withButton({ style: 'solid', font_weight: '900' }))).toThrow();
  });
});

describe('layout (HUGO-1815)', () => {
  function withLayout(layout?: unknown) {
    const c = config({});
    return { ui_theme: { ...c.ui_theme, ...(layout === undefined ? {} : { layout }) } };
  }

  it('keeps the stacked layout when absent', () => {
    const names = buildThemeClassNames(buildThemeFromConfig(withLayout()));
    expect(names.pageContainer).toContain('max-w-lg');
    expect(names.languageSelectorWrap).toBe('mb-4 flex justify-end');
    expect(names.logoImage).toBe('h-10 w-auto');
    expect(names.appShell).not.toContain('items-center');
  });

  it('centres the page and moves the language switch to the corner when centered', () => {
    const names = buildThemeClassNames(buildThemeFromConfig(withLayout('centered')));
    expect(names.appShell).toContain('items-center');
    expect(names.pageContainer).toContain('max-w-md');
    expect(names.languageSelectorWrap).toContain('absolute');
    expect(names.logoImage).toBe('h-auto w-[150px]');
  });

  it('rejects an unknown layout', () => {
    expect(() => buildThemeFromConfig(withLayout('grid'))).toThrow();
  });
});
