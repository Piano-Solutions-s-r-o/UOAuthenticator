import type { EmailLocale } from '../services/email.templates.js';

/**
 * Resolve which hand-authored email locale to use from an HTTP `Accept-Language`
 * header (HUGO-553). We only author copy for English and Czech, so anything else
 * — or a missing/garbled header — falls back to English. Language tags are
 * honoured in the order the client lists them (browsers send them in preference
 * order); q-weights are ignored deliberately to keep this deterministic.
 */
export function resolveEmailLocale(acceptLanguage?: string | null): EmailLocale {
  if (!acceptLanguage) return 'en';

  for (const part of acceptLanguage.split(',')) {
    const tag = part.split(';')[0]?.trim().toLowerCase();
    if (!tag) continue;
    const primary = tag.split('-')[0];
    if (primary === 'cs') return 'cs';
    if (primary === 'en') return 'en';
  }

  return 'en';
}
