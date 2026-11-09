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

export type RegistrationVerificationCopy = {
  subject: string;
  heading: string;
  body: (email: string) => string;
  buttonLabel: string;
  codeLabel: string;
  expiry: (hours: number) => string;
  ignoreLabel: string;
};

/**
 * The browser-bound registration email. The address is in the text because the link finishes the
 * registration where it is clicked. Czech is informal (tykání), in the voice of the sign-in email
 * above. "Hugo" is literal: only Hugo runs this flow, a product's name has no field in the signed
 * config, and Czech declines it as a man's name (`v Hugovi`, `Huga`).
 */
const REGISTRATION_VERIFICATION_COPY: Record<EmailLocale, RegistrationVerificationCopy> = {
  en: {
    subject: 'Your registration link',
    heading: "Let's finish signing you up",
    body: (email) => `You're one tap away. Use the button below to finish registering the account for ${email}.`,
    buttonLabel: 'Continue',
    codeLabel: 'Or enter this code in Hugo:',
    expiry: (hours) => `Tick tock — the link and code are good for ${hours} hours.`,
    ignoreLabel: "Wasn't you? Don't click anything and pretend this never happened.",
  },
  cs: {
    subject: 'Tvůj registrační odkaz',
    heading: 'Pojďme dokončit registraci',
    body: (email) => `Jsi jen jedno kliknutí od cíle. Klikni na tlačítko níže a dokončíš registraci účtu pro ${email}.`,
    buttonLabel: 'Pokračovat',
    codeLabel: 'Nebo zadej v Hugovi kód:',
    expiry: (hours) => `Tik ťak — odkaz i kód platí ${hours} hodin.`,
    ignoreLabel: 'Tohle jsi nebyl(a) ty? Na nic neklikej a rychle na to zapomeň.',
  },
};

export function registrationVerificationCopy(locale?: EmailLocale): RegistrationVerificationCopy {
  return REGISTRATION_VERIFICATION_COPY[locale ?? 'en'] ?? REGISTRATION_VERIFICATION_COPY.en;
}

export type RegistrationReminderCopy = {
  subject: string;
  heading: string;
  /** Shown above the button. */
  body: string;
  /** Shown below the button. */
  closing: string;
  ignoreLabel: string;
};

/**
 * The one reminder to an unconfirmed registration (HUGO-2424). Czech is the owner's wording,
 * verbatim. The English is a draft awaiting the owner's approval. The button reuses the
 * registration e-mail's label, so it is not repeated here.
 */
const REGISTRATION_REMINDER_COPY: Record<EmailLocale, RegistrationReminderCopy> = {
  en: {
    subject: 'Tick tock, your Hugo sign-in link is waiting',
    heading: "Let's get you signed in for real! 💛",
    body: "Your link is only valid for a few more hours, so don't miss it! You're just one click away. Don't be shy — click the button below, finish signing up and let's get going big time",
    closing: "Then we'll finally get rolling together!",
    ignoreLabel: "Wasn't this you? Just forget about it!",
  },
  cs: {
    subject: 'Tik ťak, tvůj přihlašovací odkaz do Huga čeká',
    heading: 'Pojďme tě opravdu přihlásit! 💛',
    body: 'Odkaz platí už jen pár hodin, tak to neprošvihni! Jsi totiž jen jedno kliknutí od cíle. Nestyď se, klikni na tlačítko níže, dokonči registraci a rozjeď to se mnou ve velkém',
    closing: 'Pak to spolu konečně rozjedem!',
    ignoreLabel: 'Tohle jsi nebyl/a ty? Tak na to rychle zapomeň!',
  },
};

export function registrationReminderCopy(locale?: EmailLocale): RegistrationReminderCopy {
  return REGISTRATION_REMINDER_COPY[locale ?? 'en'] ?? REGISTRATION_REMINDER_COPY.en;
}
