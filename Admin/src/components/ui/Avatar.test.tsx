// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Avatar, avatarInitials } from './Avatar';

describe('Avatar', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders initials when no image source is provided', () => {
    const { container } = render(<Avatar label="Ada Lovelace" />);

    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('AL')).toBeTruthy();
  });

  it('shows the image only once it has actually loaded', () => {
    const { container } = render(<Avatar label="Ada Lovelace" src="blob:avatar" />);
    const image = container.querySelector('img');

    expect(image?.getAttribute('src')).toBe('blob:avatar');
    expect(image?.className).toContain('hidden');
    expect(screen.getByText('AL')).toBeTruthy();

    fireEvent.load(image as HTMLImageElement);

    expect(container.querySelector('img')?.className).not.toContain('hidden');
    expect(screen.queryByText('AL')).toBeNull();
  });

  it('keeps initials when a blocked image never fires load or error', () => {
    // A CSP-blocked blob: URL can be dropped silently, so the error-based fallback never
    // runs. The load gate is what keeps this from rendering as an empty circle.
    const { container } = render(<Avatar label="Ada Lovelace" src="blob:blocked" />);

    expect(container.querySelector('img')?.className).toContain('hidden');
    expect(screen.getByText('AL')).toBeTruthy();
  });

  it('falls back to initials when the image fails to load', () => {
    const { container } = render(<Avatar label="Ada Lovelace" src="blob:broken" />);
    const image = container.querySelector('img');
    expect(image).not.toBeNull();

    fireEvent.error(image as HTMLImageElement);

    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('AL')).toBeTruthy();
  });
});

describe('avatarInitials', () => {
  it('handles empty, padded, and multi-space labels', () => {
    expect(avatarInitials('')).toBe('?');
    expect(avatarInitials('   ')).toBe('?');
    expect(avatarInitials('  ada  ')).toBe('AD');
    expect(avatarInitials('Ada   Byron Lovelace')).toBe('AB');
  });
});
