import { loginRestartUrl } from '../utils/login-restart.js';
import { Button } from '../components/ui/Button.js';
import React from 'react';

import { LoginForm } from '../components/form/LoginForm.js';
import { SocialButtons } from '../components/form/SocialButtons.js';
import { useTheme } from '../hooks/use-theme.js';
import { usePopup } from '../hooks/use-popup.js';
import { useTranslation } from '../i18n/use-translation.js';
import { isEmailPasswordEnabled } from '../utils/auth-config.js';

export function LoginPage(): React.JSX.Element {
  const { classNames } = useTheme();
  const { t } = useTranslation();
  const { config, codeChallenge, codeChallengeMethod, twoFaToken, twoFaSetupToken, redirectTo } = usePopup();
  const restartUrl = loginRestartUrl(config);
  if (restartUrl && (!codeChallenge || codeChallengeMethod !== 'S256') && !twoFaToken && !twoFaSetupToken) {
    return (
      <div>
        <h1 className={`text-balance ${classNames.title}`}>{t('auth.login.title')}</h1>
        <p className="mt-4 text-sm">{t('auth.login.restartRequired')}</p>
        <div className="mt-6">
          <Button type="button" onClick={() => redirectTo(restartUrl)}>{t('nav.backToLogin')}</Button>
        </div>
      </div>
    );
  }
  const showEmailPassword = isEmailPasswordEnabled(config);

  return (
    <div>
      <h1 className={`text-balance ${classNames.title}`}>{t('auth.login.title')}</h1>
      {showEmailPassword ? <LoginForm /> : null}
      <div className="mt-6">
        <SocialButtons showDivider={showEmailPassword} />
      </div>
    </div>
  );
}
