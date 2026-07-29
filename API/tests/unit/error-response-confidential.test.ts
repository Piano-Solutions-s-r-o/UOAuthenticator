// The public error body for the confidential provisioning path.
//
// CLAUDE.md: "All auth errors are generic to the user." The `/org/*` confidential
// path introduced four distinct codes so operators can separate a failed
// confidential token from a failed user token in logs. This asserts that the
// distinction stays an OPERATOR signal — the production response body is the same
// generic shape it is for every other auth failure, and the codes only surface
// when DEBUG_ENABLED is explicitly turned on.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PUBLIC_ERROR_MESSAGE } from '../../src/config/constants.js';
import { AppError } from '../../src/utils/errors.js';
import { buildPublicErrorBody } from '../../src/utils/error-response.js';

const CONFIDENTIAL_CODES = [
  ['CONFIDENTIAL_TOKEN_INVALID', 401],
  ['CONFIDENTIAL_TOKEN_DOMAIN_MISMATCH', 403],
  ['CONFIDENTIAL_SCOPE_MISSING', 403],
  ['CONFIDENTIAL_DOMAIN_ROLE_MISSING', 403],
] as const;

const originalDebug = process.env.DEBUG_ENABLED;

beforeEach(() => {
  Reflect.deleteProperty(process.env, 'DEBUG_ENABLED');
});

afterEach(() => {
  if (originalDebug === undefined) Reflect.deleteProperty(process.env, 'DEBUG_ENABLED');
  else process.env.DEBUG_ENABLED = originalDebug;
});

describe('confidential provisioning error bodies', () => {
  it.each(CONFIDENTIAL_CODES)(
    'returns the generic production body for %s and never leaks the code',
    (code, statusCode) => {
      const body = buildPublicErrorBody({
        error: new AppError(statusCode === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN', statusCode, code),
        statusCode,
      });

      expect(body).toEqual({ error: PUBLIC_ERROR_MESSAGE });
    },
  );

  it('matches the generic body the HS256 path produces, so the two are indistinguishable', () => {
    const hs256 = buildPublicErrorBody({
      error: new AppError('UNAUTHORIZED', 401, 'INVALID_ACCESS_TOKEN'),
      statusCode: 401,
    });
    const confidential = buildPublicErrorBody({
      error: new AppError('UNAUTHORIZED', 401, 'CONFIDENTIAL_TOKEN_INVALID'),
      statusCode: 401,
    });

    expect(confidential).toEqual(hs256);
  });

  it.each(CONFIDENTIAL_CODES)(
    'explains %s for operators when DEBUG_ENABLED is set',
    (code, statusCode) => {
      process.env.DEBUG_ENABLED = 'true';

      const body = buildPublicErrorBody({
        error: new AppError(statusCode === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN', statusCode, code),
        statusCode,
      });

      expect(body.code).toBe(code);
      // A dedicated explanation, not the generic per-status fallback.
      expect(body.summary).toMatch(/confidential provisioning|acting user/i);
      expect(body.hints?.length).toBeGreaterThan(0);
    },
  );
});
