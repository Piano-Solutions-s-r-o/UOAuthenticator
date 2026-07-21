import { describe, expect, it } from 'vitest';

import { killSwitchEntryToInput } from './FeatureFlagDetailPage';
import type { KillSwitchEntry } from '../features/admin/types';

// HUGO-940: a kill-switch PATCH rewrites every column, so the inline Active/Paused
// toggle must resend all fields — including storeUrl — or it would clear a set
// Update URL. This locks that invariant.
const entry: KillSwitchEntry = {
  id: 'ks_1',
  name: 'Block legacy',
  platformMode: 'selected',
  platformIds: ['ios'],
  type: 'soft',
  versionField: 'versionName',
  operator: 'lt',
  versionValue: '1.0.3',
  versionMax: null,
  versionScheme: 'semver',
  latestVersion: '1.0.3',
  active: true,
  priority: 10,
  cacheTtl: 600,
  storeUrl: 'https://testflight.apple.com/join/Ym6jXbkA',
  updated: '2026-07-21',
};

describe('killSwitchEntryToInput', () => {
  it('preserves storeUrl when toggling active (no data loss)', () => {
    const input = killSwitchEntryToInput(entry, { active: false });
    expect(input.active).toBe(false);
    expect(input.storeUrl).toBe('https://testflight.apple.com/join/Ym6jXbkA');
  });

  it('carries every editable field through so a PATCH cannot null one', () => {
    const input = killSwitchEntryToInput(entry);
    expect(input).toMatchObject({
      name: 'Block legacy',
      platform: 'ios',
      type: 'soft',
      versionField: 'versionName',
      operator: 'lt',
      versionValue: '1.0.3',
      versionMax: null,
      versionScheme: 'semver',
      latestVersion: '1.0.3',
      active: true,
      priority: 10,
      cacheTtl: 600,
      storeUrl: 'https://testflight.apple.com/join/Ym6jXbkA',
    });
  });

  it('maps an all-platforms entry to platform "both"', () => {
    const input = killSwitchEntryToInput({ ...entry, platformMode: 'all', platformIds: [] });
    expect(input.platform).toBe('both');
  });
});
