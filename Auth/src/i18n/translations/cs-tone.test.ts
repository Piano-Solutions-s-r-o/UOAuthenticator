import { describe, expect, it } from 'vitest';

import { cs } from './cs.js';

// HUGO-1815: Hugo addresses operators informally (tykání). Formal second-person forms must not
// come back into the Czech auth UI.
const FORMAL =
  /(?<!\p{L})(Vy|Vám|vám|Vás|vás|Váš|váš|Vaše|vaše|Vašich|vašich|jste|Jste)(?!\p{L})|\p{L}+(ejte|ěte|ujte|uste|ete|ňte|ťte|ďte)(?!\p{L})/u;

describe('Czech auth UI tone', () => {
  it('uses informal address in every string', () => {
    const formal = Object.entries(cs).filter(([, value]) => FORMAL.test(value));
    expect(formal).toEqual([]);
  });
});
