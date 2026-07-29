import { describe, expect, it } from 'vitest';

import {
  AVATAR_DEFAULT_SIZE,
  AVATAR_STYLES,
  clampAvatarSize,
  djb2,
  generateAvatarSvg,
  pickAvatarStyle,
  resolveAvatarStyle,
} from '../../src/utils/avatar-svg.js';

const USER_ID = 'usr_9f3c1b2a';

describe('avatar-svg generator', () => {
  it('is deterministic: identical inputs produce byte-identical SVG', () => {
    for (const style of AVATAR_STYLES) {
      const first = generateAvatarSvg({ userId: USER_ID, style, size: 128 });
      const second = generateAvatarSvg({ userId: USER_ID, style, size: 128 });
      expect(second).toBe(first);
    }
  });

  it('produces a different image for a different user', () => {
    const a = generateAvatarSvg({ userId: 'user-a', style: 'tiles' });
    const b = generateAvatarSvg({ userId: 'user-b', style: 'tiles' });
    expect(a).not.toBe(b);
  });

  it('renders four visually distinct styles for the same user', () => {
    const rendered = AVATAR_STYLES.map((style) => generateAvatarSvg({ userId: USER_ID, style }));
    expect(new Set(rendered).size).toBe(AVATAR_STYLES.length);
  });

  it('keeps the viewBox constant and only varies width/height with size', () => {
    const small = generateAvatarSvg({ userId: USER_ID, style: 'rings', size: 32 });
    const large = generateAvatarSvg({ userId: USER_ID, style: 'rings', size: 256 });

    expect(small).toContain('viewBox="0 0 100 100"');
    expect(large).toContain('viewBox="0 0 100 100"');
    expect(small).toContain('width="32" height="32"');
    expect(large).toContain('width="256" height="256"');
    // Same geometry, different frame.
    expect(small.replace('width="32" height="32"', 'width="256" height="256"')).toBe(large);
  });

  it('emits no scripts, foreign objects, or external references', () => {
    for (const style of AVATAR_STYLES) {
      const svg = generateAvatarSvg({ userId: USER_ID, style });
      expect(svg).not.toMatch(/<script/i);
      expect(svg).not.toMatch(/foreignObject/i);
      expect(svg).not.toMatch(/xlink:href/i);
      expect(svg).not.toMatch(/<image/i);
      expect(svg).not.toMatch(/url\(/i);
      expect(svg).not.toMatch(/\son\w+=/i);
    }
  });

  it('mono uses no colour: black, white and greys only', () => {
    // Every seed picks one of mono's two patterns; check a spread of them.
    for (let i = 0; i < 40; i++) {
      const svg = generateAvatarSvg({ userId: `mono-user-${i}`, style: 'mono' });
      expect(svg).not.toMatch(/hsl\(/i);
      expect(svg).not.toMatch(/rgb\(/i);
      // The only fills present are the monochrome constants.
      const fills = [...svg.matchAll(/fill="([^"]+)"/g)].map((match) => match[1]);
      expect(fills.length).toBeGreaterThan(0);
      for (const fill of fills) {
        expect(['#ffffff', '#000000', 'none']).toContain(fill);
      }
    }
  });

  it('colours the other three styles from the seeded hue', () => {
    for (const style of ['tiles', 'waves', 'rings'] as const) {
      expect(generateAvatarSvg({ userId: USER_ID, style })).toMatch(/hsl\(\d+, 55%, \d+%\)/);
    }
  });
});

describe('avatar seed and style selection', () => {
  it('matches the documented djb2 contract', () => {
    // djb2 of "a": (5381 * 33) ^ 97
    expect(djb2('a')).toBe(((5381 * 33) ^ 97) >>> 0);
    expect(djb2('')).toBe(5381);
    expect(djb2(USER_ID)).toBe(djb2(USER_ID));
  });

  it('picks a stable per-user style from the seed', () => {
    const expected = AVATAR_STYLES[djb2(USER_ID) % AVATAR_STYLES.length];
    expect(pickAvatarStyle(USER_ID)).toBe(expected);
    expect(pickAvatarStyle(USER_ID)).toBe(expected);
  });

  it('applies the order: query override > config default > per-user pick', () => {
    expect(
      resolveAvatarStyle({ userId: USER_ID, requested: 'waves', configDefault: 'mono' }),
    ).toBe('waves');

    expect(resolveAvatarStyle({ userId: USER_ID, requested: null, configDefault: 'mono' })).toBe(
      'mono',
    );

    expect(resolveAvatarStyle({ userId: USER_ID })).toBe(pickAvatarStyle(USER_ID));
  });

  it('ignores unusable style values at each level', () => {
    expect(
      resolveAvatarStyle({
        userId: USER_ID,
        requested: 'sparkles' as never,
        configDefault: 'rings',
      }),
    ).toBe('rings');

    expect(
      resolveAvatarStyle({ userId: USER_ID, configDefault: 'sparkles' as never }),
    ).toBe(pickAvatarStyle(USER_ID));
  });

  it('clamps size to 16-512 and defaults to 128', () => {
    expect(clampAvatarSize()).toBe(AVATAR_DEFAULT_SIZE);
    expect(clampAvatarSize(null)).toBe(AVATAR_DEFAULT_SIZE);
    expect(clampAvatarSize(Number.NaN)).toBe(AVATAR_DEFAULT_SIZE);
    expect(clampAvatarSize(1)).toBe(16);
    expect(clampAvatarSize(10_000)).toBe(512);
    expect(clampAvatarSize(64)).toBe(64);
  });
});
