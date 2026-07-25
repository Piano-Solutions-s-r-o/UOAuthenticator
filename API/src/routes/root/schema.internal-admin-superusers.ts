import { IDENTITY_AVATAR_URL_NOTE } from './schema.avatars.js';
import type { EndpointSchema } from './schema.js';

/**
 * ADMIN_AUTH_DOMAIN superuser management, split out of `schema.internal-admin.ts` to keep that
 * file under the project's 500-line limit (CLAUDE.md) — same slice pattern as the apps,
 * delegation and signature schema files.
 */
export function buildInternalAdminSuperuserEndpoints(params: {
  adminAuth: string;
  authFailures: string;
}): EndpointSchema[] {
  const { adminAuth, authFailures } = params;

  return [
    {
      method: 'GET',
      path: '/internal/admin/superusers',
      description: 'List users with SUPERUSER on ADMIN_AUTH_DOMAIN',
      auth: adminAuth,
      response: {
        200: 'Array of { userId, email, name, avatarImageUrl, createdAt }',
        '401/403': authFailures,
      },
      notes: IDENTITY_AVATAR_URL_NOTE,
    },
    {
      method: 'GET',
      path: '/internal/admin/superusers/search',
      description: 'Search non-superuser UOA users by email or name',
      auth: adminAuth,
      query: { q: 'string (optional)' },
      response: {
        200: 'Array of { userId, email, name, avatarImageUrl }',
        '401/403': authFailures,
      },
      notes: IDENTITY_AVATAR_URL_NOTE,
    },
    {
      method: 'POST',
      path: '/internal/admin/superusers',
      description: 'Grant SUPERUSER on ADMIN_AUTH_DOMAIN to an existing user',
      auth: adminAuth,
      body: { userId: 'string (required)' },
      response: {
        201: '{ userId, email, name, avatarImageUrl, createdAt }',
        '401/403': authFailures,
      },
      notes: IDENTITY_AVATAR_URL_NOTE,
    },
    {
      method: 'DELETE',
      path: '/internal/admin/superusers/:userId',
      description: 'Revoke SUPERUSER on ADMIN_AUTH_DOMAIN; refuses self-removal and last-superuser removal',
      auth: adminAuth,
      response: { 204: 'No content', 409: 'generic conflict for safety rails', '401/403': authFailures },
    },
  ];
}
