import { describe, expect, it } from 'vitest';

import { KillSwitchFormSchema } from './admin';

// HUGO-940: the optional "Update URL" field. Empty = App Store / Play default;
// a value must be an absolute https URL (the POS launches it).
describe('KillSwitchFormSchema.storeUrl', () => {
  const base = {
    platform: 'both',
    type: 'soft' as const,
    versionField: 'versionName' as const,
    operator: 'lt' as const,
    versionValue: '1.0.3',
    versionScheme: 'semver' as const,
    active: 'active' as const,
    priority: 0,
    cacheTtl: 3600,
  };

  it('accepts an empty storeUrl (default)', () => {
    expect(KillSwitchFormSchema.safeParse({ ...base, storeUrl: '' }).success).toBe(true);
  });

  it('accepts an omitted storeUrl (optional)', () => {
    expect(KillSwitchFormSchema.safeParse(base).success).toBe(true);
  });

  it('accepts a valid https storeUrl', () => {
    expect(
      KillSwitchFormSchema.safeParse({
        ...base,
        storeUrl: 'https://testflight.apple.com/join/Ym6jXbkA',
      }).success,
    ).toBe(true);
  });

  it('rejects a non-https (http) storeUrl', () => {
    expect(
      KillSwitchFormSchema.safeParse({ ...base, storeUrl: 'http://insecure.example.com' }).success,
    ).toBe(false);
  });

  it('rejects a non-URL storeUrl', () => {
    expect(KillSwitchFormSchema.safeParse({ ...base, storeUrl: 'not a url' }).success).toBe(false);
  });

  it('rejects an https URL with no host', () => {
    expect(KillSwitchFormSchema.safeParse({ ...base, storeUrl: 'https:foo' }).success).toBe(false);
  });
});
