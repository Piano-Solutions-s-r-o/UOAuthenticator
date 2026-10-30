import React, { useState } from 'react';

import { SetPasswordForm } from '../components/form/SetPasswordForm.js';
import { usePopup } from '../hooks/use-popup.js';
import { useTheme } from '../hooks/use-theme.js';
import { useTranslation } from '../i18n/use-translation.js';

export function SetPasswordPage(): React.JSX.Element {
  const { registrationHandoff, pendingRegistration } = usePopup();
  const { classNames } = useTheme();
  const { t } = useTranslation();
  // Shown because a link can reach someone else: the address says whose account this creates.
  // Held for the life of the view: the form forgets the registration just before it navigates away.
  const [email] = useState(() => registrationHandoff?.email ?? pendingRegistration?.email);
  const [beforeEmail, afterEmail] = t('registration.password.text', { email: '{email}' }).split('{email}');

  return (
    <div>
      <h1 className={`text-balance ${classNames.title}`}>
        {t(email ? 'registration.password.title' : 'auth.setPassword.title')}
      </h1>
      {email ? (
        <p className="mt-3 text-sm text-[var(--uoa-color-text)]">
          {beforeEmail}
          <strong>{email}</strong>
          {afterEmail}
        </p>
      ) : null}
      <SetPasswordForm registering={Boolean(email)} />
    </div>
  );
}
