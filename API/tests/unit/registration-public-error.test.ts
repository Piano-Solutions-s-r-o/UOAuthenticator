import type { FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAuthDebugInfo } from '../../src/services/auth-debug-page.service.js';
import { buildPublicErrorBody } from '../../src/utils/error-response.js';
import { AppError } from '../../src/utils/errors.js';

// HUGO-2261: the waiting registration window ends only on this code. A failed config fetch has to
// keep answering without it, or one short product outage ends every registration in progress.
describe('public error body of the registration status route', () => {
  it('names the final refusal', () => {
    expect(buildPublicErrorBody({
      error: new AppError('BAD_REQUEST', 400, 'REGISTRATION_UNAVAILABLE'), statusCode: 400,
    })).toEqual({ error: 'Request failed', code: 'REGISTRATION_UNAVAILABLE' });
  });

  // config-fetch.service.ts throws the bare one when the product's config URL does not answer.
  it.each([undefined, 'CONFIG_URL_REJECTED', 'CONFIG_SCHEMA_INVALID'])('stays bare for %s', (code) => {
    expect(buildPublicErrorBody({
      error: new AppError('BAD_REQUEST', 400, code), statusCode: 400,
    })).toEqual({ error: 'Request failed' });
  });
});

// Debug mode rewrites /auth errors into its own codes. The window would then never see the final
// refusal and would poll for as long as the tab stays open.
describe('public error body with DEBUG_ENABLED', () => {
  const original = process.env.DEBUG_ENABLED;
  beforeEach(() => { process.env.DEBUG_ENABLED = 'true'; });
  afterEach(() => {
    if (original === undefined) delete process.env.DEBUG_ENABLED;
    else process.env.DEBUG_ENABLED = original;
  });

  it('keeps the code the window acts on', () => {
    // configVerifier sets authDebug on every real request; without it the debug path is skipped.
    const url = '/auth/registration/status?id=x';
    const request = { raw: { url }, query: {}, authDebug: createAuthDebugInfo({ requestUrl: url }) } as unknown as FastifyRequest;
    const body = buildPublicErrorBody({
      request, error: new AppError('BAD_REQUEST', 400, 'REGISTRATION_UNAVAILABLE'), statusCode: 400,
    });
    expect(body.code).toBe('REGISTRATION_UNAVAILABLE');
  });
});
