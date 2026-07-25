// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UserAvatarSection } from './UserAvatarSection';

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  deleteMutateAsync: vi.fn(),
  uploadMutateAsync: vi.fn(),
}));

vi.mock('./admin-queries', () => ({
  useUserAvatarQuery: () => ({ data: undefined }),
  useUploadUserAvatarMutation: () => ({ isPending: false, mutateAsync: mocks.uploadMutateAsync }),
  useDeleteUserAvatarMutation: () => ({ isPending: false, mutateAsync: mocks.deleteMutateAsync }),
}));

vi.mock('../shell/admin-ui', () => ({
  useAdminUi: () => ({ confirm: mocks.confirm }),
}));

describe('UserAvatarSection', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.uploadMutateAsync.mockResolvedValue({ ok: true });
    mocks.deleteMutateAsync.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    cleanup();
  });

  it('rejects an image over 1 MB before uploading and accepts a smaller one', async () => {
    const user = userEvent.setup();
    render(<UserAvatarSection userId="user-1" userName="Ada Lovelace" />);
    const input = screen.getByLabelText(/Upload new avatar/);

    await user.upload(input, new File([new Uint8Array(1024 * 1024 + 1)], 'big.png', { type: 'image/png' }));

    expect(mocks.uploadMutateAsync).not.toHaveBeenCalled();
    expect(screen.getByText(/larger than 1 MB/i)).toBeTruthy();

    const small = new File(['png'], 'face.png', { type: 'image/png' });
    await user.upload(input, small);

    expect(mocks.uploadMutateAsync).toHaveBeenCalledWith(small);
    expect(screen.queryByText(/larger than 1 MB/i)).toBeNull();
  });

  it('removes the avatar only through the shared confirmation', async () => {
    const user = userEvent.setup();
    render(<UserAvatarSection userId="user-1" userName="Ada Lovelace" />);

    await user.click(screen.getByRole('button', { name: 'Remove' }));

    expect(mocks.deleteMutateAsync).not.toHaveBeenCalled();
    const confirmation = mocks.confirm.mock.calls[0] as [string, string, () => Promise<void>];
    expect(confirmation[0]).toBe('Remove uploaded avatar?');

    await confirmation[2]();

    expect(mocks.deleteMutateAsync).toHaveBeenCalledTimes(1);
  });
});
