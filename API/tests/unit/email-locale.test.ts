import { describe, expect, it } from 'vitest';

import { resolveEmailLocale } from '../../src/utils/email-locale.js';

describe('resolveEmailLocale', () => {
  it('defaults to English when the header is missing', () => {
    expect(resolveEmailLocale(undefined)).toBe('en');
    expect(resolveEmailLocale(null)).toBe('en');
    expect(resolveEmailLocale('')).toBe('en');
  });

  it('returns cs for Czech browsers (with or without region)', () => {
    expect(resolveEmailLocale('cs')).toBe('cs');
    expect(resolveEmailLocale('cs-CZ')).toBe('cs');
    expect(resolveEmailLocale('cs-CZ,cs;q=0.9,en;q=0.8')).toBe('cs');
  });

  it('returns en for English browsers', () => {
    expect(resolveEmailLocale('en-US,en;q=0.9')).toBe('en');
  });

  it('honours preference order between supported locales', () => {
    expect(resolveEmailLocale('en-GB,cs;q=0.5')).toBe('en');
    expect(resolveEmailLocale('cs-CZ,en-US;q=0.5')).toBe('cs');
  });

  it('falls back to English for unsupported languages', () => {
    expect(resolveEmailLocale('de-DE,fr;q=0.7')).toBe('en');
    expect(resolveEmailLocale('sk')).toBe('en');
  });

  it('skips unsupported tags and picks the first supported one', () => {
    expect(resolveEmailLocale('de,cs;q=0.8,en;q=0.7')).toBe('cs');
  });
});
