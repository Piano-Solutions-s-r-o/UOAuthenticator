import { REGISTRATION_EMAIL_TOKEN_TTL_MS } from '../config/constants.js';

/** Locales we hand-author email copy for. Anything else falls back to English. */
export type EmailLocale = 'en' | 'cs';

export type RegistrationCopy = {
  subject: string;
  heading: string;
  /** Body sentence shown above the button (HTML) and re-used as the text intro. */
  body: string;
  buttonLabel: string;
  expiryHours: (hours: number) => string;
  expiryMinutes: (minutes: number) => string;
  fallbackLabel: string;
  ignoreLabel: string;
};

const CS_PLURAL = new Intl.PluralRules('cs');

/**
 * Czech noun form for a whole-number count (CLDR rules: 1 → one, 2–4 → few,
 * everything else → other). The object after "platí" is accusative, so the
 * singular is "1 hodinu" / "1 minutu"; "few" and "other" match the nominative.
 */
function csPlural(count: number, one: string, few: string, other: string): string {
  const category = CS_PLURAL.select(count);
  if (category === 'one') return one;
  if (category === 'few') return few;
  return other;
}

/**
 * Sign-in / registration email copy in Hugo's voice (HUGO-553). One neutral
 * template serves login-link, verify-email, set-password and account-exists,
 * so the wording must read naturally for both a returning login and finishing
 * signup. English is the source; unsupported locales fall back to it.
 */
const REGISTRATION_COPY: Record<EmailLocale, RegistrationCopy> = {
  en: {
    subject: 'Your sign-in link',
    heading: "Let's get you in",
    body: "You're one tap away. Use the button below to reach your account or finish signing up.",
    buttonLabel: 'Continue',
    expiryHours: (hours) => `Tick tock — this link's good for ${hours} hours, and one use only.`,
    expiryMinutes: (minutes) =>
      `Tick tock — this link's good for ${minutes} minutes, and one use only.`,
    fallbackLabel: 'Button playing dead? Paste this URL into your browser:',
    ignoreLabel: "Wasn't you? Pretend this never happened.",
  },
  cs: {
    subject: 'Tvůj přihlašovací odkaz do Huga',
    heading: 'Pojďme tě přihlásit! 💛',
    body: 'Jsi jen jedno kliknutí od cíle. Tak se nestyď, klikni na tlačítko níže — dostaneš se ke svému účtu, nebo dokončíš registraci a rozjedeš to se mnou ve velkém.',
    buttonLabel: 'Pokračovat',
    expiryHours: (hours) =>
      `Tik ťak ⏰ odkaz platí ${hours} ${csPlural(hours, 'hodinu', 'hodiny', 'hodin')} a použít ho můžeš jen jednou.`,
    expiryMinutes: (minutes) =>
      `Tik ťak ⏰ odkaz platí ${minutes} ${csPlural(minutes, 'minutu', 'minuty', 'minut')} a použít ho můžeš jen jednou.`,
    fallbackLabel: 'Tlačítko nereaguje? Zkopíruj tuhle adresu do prohlížeče:',
    ignoreLabel: 'Nečekáš tenhle mail? Tak na to rychle zapomeň!',
  },
};

export function registrationCopy(locale?: EmailLocale): RegistrationCopy {
  return REGISTRATION_COPY[locale ?? 'en'] ?? REGISTRATION_COPY.en;
}

export function registrationTokenTtlHours(): number {
  return Math.max(1, Math.round(REGISTRATION_EMAIL_TOKEN_TTL_MS / (60 * 60 * 1000)));
}
