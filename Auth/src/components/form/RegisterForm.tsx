import React, { useState } from 'react';

import { Button } from '../ui/Button.js';
import { Input } from '../ui/Input.js';
import { usePopup } from '../../hooks/use-popup.js';
import { useTheme } from '../../hooks/use-theme.js';
import { useTranslation } from '../../i18n/use-translation.js';
import { postJson } from '../../utils/api.js';

type RegisterRequest = { email: string };

/**
 * HUGO-1858: the single owner of "where does the way back to sign in live". With the same
 * switch as LoginForm's create-account button (`button.create_account: secondary`), RegisterForm
 * renders it as a secondary button in every state it shows (form, sent confirmation and
 * already-registered);
 * otherwise RegisterPage keeps its text link below the social buttons.
 */
export function useBackToLoginAsButton(): boolean {
  return useTheme().theme.button.createAccount === 'secondary';
}

export function RegisterForm(props: {
  /** Seeds for SSR tests, like PopupProvider's `initial*` props; the flow sets them on submit. */
  initialSubmitted?: boolean;
  initialAlreadyRegistered?: boolean;
  initialLoading?: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { configUrl, redirectUrl, codeChallenge, codeChallengeMethod, requestAccess, setView } =
    usePopup();
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(props.initialSubmitted ?? false);
  const [alreadyRegistered, setAlreadyRegistered] = useState(
    props.initialAlreadyRegistered ?? false,
  );
  const [loading, setLoading] = useState(props.initialLoading ?? false);
  // Never disabled: while /auth/register is pending (it has no timeout) this is the only way
  // out, as the page-level link was before it.
  const backToLoginButton = useBackToLoginAsButton() ? (
    <Button variant="secondaryFilled" type="button" onClick={() => setView('login')}>
      {t('nav.backToLogin')}
    </Button>
  ) : null;

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);

    const query: Record<string, string | boolean | null> = { config_url: configUrl };
    if (redirectUrl) query.redirect_url = redirectUrl;
    if (codeChallenge && codeChallengeMethod) {
      query.code_challenge = codeChallenge;
      query.code_challenge_method = codeChallengeMethod;
    }
    if (requestAccess) query.request_access = true;

    // Most clients keep the default no-enumeration response. A signed config
    // may opt into EMAIL_ALREADY_REGISTERED for products that prefer inline
    // sign-in guidance over a login-link email.
    const result = await postJson<RegisterRequest, unknown>('/auth/register', { email }, query);
    setLoading(false);
    if (!result.ok && result.code === 'EMAIL_ALREADY_REGISTERED') {
      setAlreadyRegistered(true);
      return;
    }
    setSubmitted(true);
  }

  if (alreadyRegistered) {
    return (
      <div className="mt-6 flex flex-col gap-3">
        <div
          role="status"
          className={[
            'rounded-[var(--uoa-radius-card)] border border-[var(--uoa-color-border)]',
            'bg-[var(--uoa-color-surface)] px-3 py-3 text-sm text-[var(--uoa-color-text)]',
          ].join(' ')}
        >
          <p>{t('message.emailAlreadyRegistered')}</p>
          <div className="mt-3 flex flex-wrap gap-3">
            {backToLoginButton ? null : (
              <button
                type="button"
                className="text-sm font-medium text-[var(--uoa-color-link)] hover:underline"
                onClick={() => setView('login')}
              >
                {t('nav.backToLogin')}
              </button>
            )}
            <button
              type="button"
              className="text-sm font-medium text-[var(--uoa-color-link)] hover:underline"
              onClick={() => setView('reset-password')}
            >
              {t('nav.resetPassword')}
            </button>
          </div>
        </div>
        {backToLoginButton}
      </div>
    );
  }

  if (submitted) {
    return (
      <div className="mt-6 flex flex-col gap-3">
        <p
          role="status"
          className={[
            'rounded-[var(--uoa-radius-card)] border border-[var(--uoa-color-border)]',
            'bg-[var(--uoa-color-surface)] px-3 py-2 text-sm text-[var(--uoa-color-text)]',
          ].join(' ')}
        >
          {t('message.instructionsSent')}
        </p>
        {backToLoginButton}
      </div>
    );
  }

  return (
    <form className="mt-6 flex flex-col gap-4" onSubmit={handleSubmit}>
      <Input
        name="email"
        type="email"
        inputMode="email"
        autoComplete="email"
        required
        label={t('form.email.label')}
        value={email}
        onChange={(e) => setEmail(e.currentTarget.value)}
      />

      <div className="mt-2 flex flex-col gap-3">
        <Button variant="primary" type="submit" disabled={loading}>
          {loading ? '...' : t('form.register.submit')}
        </Button>
        {backToLoginButton}
      </div>
    </form>
  );
}
