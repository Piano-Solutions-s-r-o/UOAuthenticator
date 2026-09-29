import { describe, expect, it } from 'vitest';

import { pickUiLocale } from './ui-locales.js';

describe('pickUiLocale', () => {
  const langs = ['en', 'cs', 'es'];

  it('returns null without a search string or ui_locales', () => {
    expect(pickUiLocale(undefined, langs)).toBeNull();
    expect(pickUiLocale('', langs)).toBeNull();
    expect(pickUiLocale('?config_url=x', langs)).toBeNull();
  });

  it('matches the primary subtag case-insensitively', () => {
    expect(pickUiLocale('?ui_locales=cs', langs)).toBe('cs');
    expect(pickUiLocale('?ui_locales=cs-CZ', langs)).toBe('cs');
    expect(pickUiLocale('?ui_locales=CS_cz', langs)).toBe('cs');
  });

  it('honours the first supported tag in a space-separated list', () => {
    expect(pickUiLocale('?config_url=x&ui_locales=de%20cs-CZ%20en', langs)).toBe('cs');
    expect(pickUiLocale('?ui_locales=cs+en', langs)).toBe('cs');
  });

  it('ignores unsupported or garbage values', () => {
    expect(pickUiLocale('?ui_locales=de', langs)).toBeNull();
    expect(pickUiLocale('?ui_locales=%00%20---', langs)).toBeNull();
    expect(pickUiLocale('?ui_locales=cs', ['en'])).toBeNull();
  });
});
