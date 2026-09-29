import { describe, expect, it } from 'vitest';

import { cs } from './cs.js';

// HUGO-1815: Hugo addresses operators informally (tykání). Formal second-person forms must not
// come back into the Czech auth UI.
// Formal pronouns, plus any word ending in "-te": Czech formal imperatives and 2nd-person plural
// verbs all do (Zadejte, Vyberte, Podepište, Zahajte, můžete, Máte), and no informal UI word here
// does.
const FORMAL =
  /(?<!\p{L})(Vy|Vám|vám|Vás|vás|Váš|váš|Vaše|vaše|Vaši|vaši|Vašeho|vašeho|Vašem|vašem|Vaším|vaším|Vašich|vašich|jste|Jste)(?!\p{L})|\p{L}+te(?!\p{L})/u;

describe('Czech auth UI tone', () => {
  it('catches the formal forms it is meant to', () => {
    for (const formal of ['Vyberte pracovní prostor', 'Zkontrolujte a podepište', 'zahajte', 'Máte účet?', 'Vašeho účtu']) {
      expect(FORMAL.test(formal)).toBe(true);
    }
  });

  it('uses informal address in every string', () => {
    const formal = Object.entries(cs).filter(([, value]) => FORMAL.test(value));
    expect(formal).toEqual([]);
  });
});
