import type { EmailLocale } from './email.registration-copy.js';

/**
 * Copy for the account-recovery / sign-in-code emails (HUGO-1815): password reset, 2FA reset and
 * the emailed sign-in code. English is the source and must stay byte-identical to what shipped
 * before localization; Czech uses informal "ty" address (Hugo's brand rule). Unsupported locales
 * fall back to English. Registration-family copy lives in `email.registration-copy.ts`.
 */
export type LinkEmailCopy = {
  subject: string;
  heading: string;
  /** Sentence shown above the button in the HTML email. */
  body: string;
  /** Intro line of the plain-text email, directly followed by the link. */
  textIntro: string;
  buttonLabel: string;
  expiry: (minutes: number) => string;
  fallbackLabel: string;
  ignoreLabel: string;
};

export type LoginCodeCopy = {
  subject: string;
  heading: string;
  /** Intro line; the plain-text email appends the code after it. */
  intro: string;
  expiry: (minutes: number) => string;
  ignoreLabel: string;
};

const CS_IGNORE = 'Pokud jsi o nic nežádal(a), tenhle e-mail klidně ignoruj.';
const CS_FALLBACK = 'Pokud tlačítko nefunguje, zkopíruj tuto adresu do prohlížeče:';
const CS_LINK_EXPIRY = (minutes: number): string =>
  `Odkaz platí ${minutes} minut a použít ho můžeš jen jednou.`;

const EN_IGNORE = 'If you did not request this, you can ignore this email.';
const EN_FALLBACK = 'If the button does not work, copy and paste this URL into your browser:';
const EN_LINK_EXPIRY = (minutes: number): string =>
  `This link expires in ${minutes} minutes and can only be used once.`;

const RECOVERY_LINK_COPY: Record<EmailLocale, LinkEmailCopy> = {
  en: {
    subject: 'Reset your password',
    heading: 'Reset your password',
    body: 'If you requested a password reset, click the button below.',
    textIntro: 'If you requested a password reset, use this link:',
    buttonLabel: 'Reset password',
    expiry: EN_LINK_EXPIRY,
    fallbackLabel: EN_FALLBACK,
    ignoreLabel: EN_IGNORE,
  },
  cs: {
    subject: 'Obnovení hesla',
    heading: 'Obnov si heslo',
    body: 'Pokud jsi žádal(a) o obnovení hesla, klikni na tlačítko níže.',
    textIntro: 'Pokud jsi žádal(a) o obnovení hesla, použij tento odkaz:',
    buttonLabel: 'Obnovit heslo',
    expiry: CS_LINK_EXPIRY,
    fallbackLabel: CS_FALLBACK,
    ignoreLabel: CS_IGNORE,
  },
};

const TWOFA_RESET_COPY: Record<EmailLocale, LinkEmailCopy> = {
  en: {
    subject: 'Reset two-factor authentication',
    heading: 'Reset two-factor authentication',
    body: 'If you requested to reset two-factor authentication, click the button below.',
    textIntro: 'If you requested to reset two-factor authentication, use this link:',
    buttonLabel: 'Reset two-factor authentication',
    expiry: EN_LINK_EXPIRY,
    fallbackLabel: EN_FALLBACK,
    ignoreLabel: EN_IGNORE,
  },
  cs: {
    subject: 'Obnovení dvoufaktorového ověření',
    heading: 'Obnovení dvoufaktorového ověření',
    body: 'Pokud jsi žádal(a) o obnovení dvoufaktorového ověření, klikni na tlačítko níže.',
    textIntro: 'Pokud jsi žádal(a) o obnovení dvoufaktorového ověření, použij tento odkaz:',
    buttonLabel: 'Obnovit dvoufaktorové ověření',
    expiry: CS_LINK_EXPIRY,
    fallbackLabel: CS_FALLBACK,
    ignoreLabel: CS_IGNORE,
  },
};

const LOGIN_CODE_COPY: Record<EmailLocale, LoginCodeCopy> = {
  en: {
    subject: 'Your sign-in code',
    heading: 'Your sign-in code',
    intro: 'Enter this code to sign in:',
    expiry: (minutes) => `This code expires in ${minutes} minutes and can only be used once.`,
    ignoreLabel: EN_IGNORE,
  },
  cs: {
    subject: 'Tvůj přihlašovací kód',
    heading: 'Tvůj přihlašovací kód',
    intro: 'Pro přihlášení zadej tento kód:',
    expiry: (minutes) => `Kód platí ${minutes} minut a použít ho můžeš jen jednou.`,
    ignoreLabel: CS_IGNORE,
  },
};

export function recoveryLinkCopy(locale?: EmailLocale): LinkEmailCopy {
  return RECOVERY_LINK_COPY[locale ?? 'en'] ?? RECOVERY_LINK_COPY.en;
}

export function twoFaResetCopy(locale?: EmailLocale): LinkEmailCopy {
  return TWOFA_RESET_COPY[locale ?? 'en'] ?? TWOFA_RESET_COPY.en;
}

export function loginCodeCopy(locale?: EmailLocale): LoginCodeCopy {
  return LOGIN_CODE_COPY[locale ?? 'en'] ?? LOGIN_CODE_COPY.en;
}
