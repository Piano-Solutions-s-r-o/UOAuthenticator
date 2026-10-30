import { describe, expect, it } from 'vitest';

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
