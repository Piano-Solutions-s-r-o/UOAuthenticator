// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Sidebar } from './Sidebar';

const mocks = vi.hoisted(() => ({
  adminUser: { email: 'ada@system.local' } as { email: string; id?: string } | null,
  useUserAvatarQuery: vi.fn(),
}));

vi.mock('../features/admin/admin-queries', () => ({
  useDashboardQuery: () => ({ data: undefined }),
  useIntegrationRequestsQuery: () => ({ data: [] }),
  useUserAvatarQuery: mocks.useUserAvatarQuery,
}));

vi.mock('../features/auth/admin-session', () => ({
  useAdminSession: () => ({ adminUser: mocks.adminUser }),
  useAdminSessionActions: () => ({ signOut: vi.fn() }),
}));

vi.mock('../features/shell/admin-ui', () => ({
  useAdminUi: () => ({ closeSidebar: vi.fn(), isSidebarOpen: true }),
}));

function renderSidebar() {
  return render(
    <MemoryRouter>
      <Sidebar />
    </MemoryRouter>,
  );
}

describe('Sidebar account chip', () => {
  beforeEach(() => {
    mocks.useUserAvatarQuery.mockReset();
    mocks.useUserAvatarQuery.mockReturnValue({ data: undefined });
  });

  afterEach(() => {
    cleanup();
  });

  it('requests the signed-in admin avatar and labels it with their email', () => {
    mocks.adminUser = { email: 'ada@system.local', id: 'user-1' };

    renderSidebar();

    expect(mocks.useUserAvatarQuery).toHaveBeenCalledWith('user-1');
    // No avatar bytes yet, so the chip shows initials derived from the email, not "SA".
    expect(screen.getByText('AD')).toBeTruthy();
    expect(screen.queryByText('SA')).toBeNull();
    expect(screen.getByText('ada@system.local')).toBeTruthy();
  });

  it('falls back to initials without querying when the session carries no user id', () => {
    mocks.adminUser = { email: 'ada@system.local' };

    renderSidebar();

    expect(mocks.useUserAvatarQuery).not.toHaveBeenCalled();
    expect(screen.getByText('AD')).toBeTruthy();
  });
});
