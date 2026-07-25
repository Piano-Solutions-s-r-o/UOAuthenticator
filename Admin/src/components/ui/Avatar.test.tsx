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

  it('renders the image when a source is provided', () => {
    const { container } = render(<Avatar label="Ada Lovelace" src="blob:avatar" />);

    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:avatar');
    expect(screen.queryByText('AL')).toBeNull();
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
