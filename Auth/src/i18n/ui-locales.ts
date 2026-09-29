/**
 * OIDC `ui_locales` (space-separated BCP-47 tags in preference order) → the first tag whose
 * primary subtag is one of the languages the client config offers. Pure and deterministic so
 * SSR and hydration always agree. Anything unsupported or malformed is ignored (returns null).
 */
export function pickUiLocale(search: string | undefined, languages: string[]): string | null {
  if (!search) return null;

  let raw: string | null;
  try {
    raw = new URLSearchParams(search).get('ui_locales');
  } catch {
    return null;
  }
  if (!raw) return null;

  for (const tag of raw.split(/\s+/)) {
    const primary = tag.split(/[-_]/)[0]?.trim().toLowerCase();
    if (!primary) continue;
    const match = languages.find((lang) => lang.toLowerCase() === primary);
    if (match) return match;
  }
  return null;
}
