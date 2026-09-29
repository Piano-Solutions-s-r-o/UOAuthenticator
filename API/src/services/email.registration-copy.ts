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
    subject: 'Tvůj přihlašovací odkaz',
    heading: 'Pojďme tě přihlásit',
    body: 'Jsi jen jedno kliknutí od cíle. Klikni na tlačítko níže a dostaneš se ke svému účtu nebo dokončíš registraci.',
    buttonLabel: 'Pokračovat',
    expiryHours: (hours) => `Tik ťak — odkaz platí ${hours} hodin a použít ho lze jen jednou.`,
    expiryMinutes: (minutes) =>
      `Tik ťak — odkaz platí ${minutes} minut a použít ho lze jen jednou.`,
    fallbackLabel: 'Tlačítko nereaguje? Zkopíruj tuto adresu do prohlížeče:',
    ignoreLabel: 'Tohle jsi nebyl(a) ty? Tak na to rychle zapomeň.',
  },
};

export function registrationCopy(locale?: EmailLocale): RegistrationCopy {
  return REGISTRATION_COPY[locale ?? 'en'] ?? REGISTRATION_COPY.en;
}

export function registrationTokenTtlHours(): number {
  return Math.max(1, Math.round(REGISTRATION_EMAIL_TOKEN_TTL_MS / (60 * 60 * 1000)));
}
