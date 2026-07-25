import { describe, expect, it } from 'vitest';

import { validateConfigFields } from '../../src/services/config.service.js';
import { AVATAR_STYLES } from '../../src/utils/avatar-svg.js';
import { baseClientConfigPayload } from '../helpers/test-config.js';

describe('avatars config claim', () => {
  it('is optional — configs without it stay valid', () => {
    const cfg = validateConfigFields(baseClientConfigPayload());
    expect(cfg.avatars).toBeUndefined();
  });

  it('accepts every documented style', () => {
    for (const style of AVATAR_STYLES) {
      const cfg = validateConfigFields(
        baseClientConfigPayload({ avatars: { default_style: style } }),
      );
      expect(cfg.avatars?.default_style).toBe(style);
    }
  });

  it('accepts an empty avatars object (no configured default)', () => {
    const cfg = validateConfigFields(baseClientConfigPayload({ avatars: {} }));
    expect(cfg.avatars?.default_style).toBeUndefined();
  });

  it('rejects an unknown default_style value', () => {
    expect(() =>
      validateConfigFields(baseClientConfigPayload({ avatars: { default_style: 'sparkles' } })),
    ).toThrow();
  });

  it('rejects a non-object avatars claim and a non-string style', () => {
    expect(() => validateConfigFields(baseClientConfigPayload({ avatars: 'waves' }))).toThrow();
    expect(() =>
      validateConfigFields(baseClientConfigPayload({ avatars: { default_style: 3 } })),
    ).toThrow();
  });
});
