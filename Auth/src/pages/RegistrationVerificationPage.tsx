import React, { useMemo, useRef, useState } from 'react';

import { Button } from '../components/ui/Button.js';
import { RegistrationCodeInput } from '../components/ui/RegistrationCodeInput.js';
import { usePopup } from '../hooks/use-popup.js';
import { useRegistrationStatus, type RegistrationState } from '../hooks/use-registration-status.js';
import { useTheme } from '../hooks/use-theme.js';
import { useTranslation } from '../i18n/use-translation.js';
import { postJson } from '../utils/api.js';
import { loginRestartUrl } from '../utils/login-restart.js';
import { applyWorkspaceOutcome, interpretWorkspaceResponse } from '../utils/workspace-response.js';

const TEXT_ACTION = 'text-sm font-medium text-[var(--uoa-color-link)] underline disabled:opacity-60';

export function RegistrationVerificationPage(): React.JSX.Element {
  const popup = usePopup();
  const { pendingRegistration: pending, config, configUrl, redirectUrl, codeChallenge, codeChallengeMethod, requestAccess } = popup;
  const { classNames } = useTheme();
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const [resent, setResent] = useState(false);
  const [sendError, setSendError] = useState(false);
  const [error, setError] = useState(false);
  const [status, setStatus] = useState<RegistrationState['status']>('pending');
  const [finish, setFinish] = useState<'continuing' | 'finished' | null>(null);
  const busy = useRef(false);
  const finishing = useRef(false);
  const query = useMemo(() => ({
    config_url: configUrl, redirect_url: redirectUrl, code_challenge: codeChallenge,
    code_challenge_method: codeChallengeMethod, request_access: requestAccess ? 'true' : undefined,
  }), [configUrl, redirectUrl, codeChallenge, codeChallengeMethod, requestAccess]);

  // The password was set elsewhere. This window goes in by itself, through the server's own checks.
  async function continueHere(id: string) {
    setFinish('continuing');
    const result = await postJson('/auth/registration/continue', { id }, query);
    if (result.ok && applyWorkspaceOutcome(interpretWorkspaceResponse(result.data), popup)) popup.beginRegistration(null);
    else setFinish('finished');
  }

  async function receive(next: RegistrationState) {
    setStatus(next.status);
    if (finishing.current || !pending) return;
    // Polling stops on this state, so it is not left for later even during a resend.
    if (next.status === 'complete') {
      finishing.current = true;
      await continueHere(pending.id);
      return;
    }
    if (busy.current || next.status !== 'authorized' || !next.token) return;
    finishing.current = true;
    if (next.token_type === 'VERIFY_EMAIL_SET_PASSWORD') {
      popup.setRegistrationProof(next.token, next.token_type);
      return;
    }
    setLoading(true);
    const result = await postJson('/auth/verify-email', { token: next.token }, query);
    if (result.ok && applyWorkspaceOutcome(interpretWorkspaceResponse(result.data), popup)) {
      popup.beginRegistration(null);
    } else {
      finishing.current = false;
      setLoading(false); setError(true);
    }
  }

  useRegistrationStatus({ id: pending?.id, query, onState: next => { void receive(next); } });

  async function submit(value: string) {
    if (!pending || busy.current || finishing.current || !/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/.test(value)) return;
    busy.current = true;
    setLoading(true); setError(false);
    const result = await postJson<{ id: string; code: string }, RegistrationState>('/auth/registration/code', { id: pending.id, code: value }, query);
    busy.current = false;
    if (result.ok) await receive(result.data);
    else setError(true);
    if (!finishing.current) setLoading(false);
  }

  async function resend() {
    if (!pending || busy.current || finishing.current) return;
    busy.current = true; setResending(true); setResent(false); setSendError(false);
    const result = await postJson<{ email: string; previous_id: string }, { registration_id: string }>('/auth/registration/start', { email: pending.email, previous_id: pending.id }, query);
    busy.current = false; setResending(false);
    if (finishing.current) return; // The registration finished meanwhile.
    if (!result.ok || typeof result.data?.registration_id !== 'string') { setSendError(true); return; }
    setCode(''); setError(false); setStatus('pending'); setResent(true);
    popup.beginRegistration({ id: result.data.registration_id, email: pending.email });
  }

  // Forgets the pending registration, so a refresh cannot bring this screen back.
  function changeEmail() {
    popup.beginRegistration(null);
    popup.setView('register');
  }

  function signIn() {
    const restartUrl = loginRestartUrl(config);
    popup.beginRegistration(null);
    if (restartUrl) popup.redirectTo(restartUrl);
    else popup.setView('login');
  }

  if (finish === 'continuing') {
    return <h1 aria-live="polite" className={`text-balance ${classNames.title}`}>{t('registration.continuing')}</h1>;
  }
  if (finish === 'finished') {
    return (
      <div>
        <h1 className={`text-balance ${classNames.title}`}>{t('registration.finished')}</h1>
        <Button type="button" className="mt-6" onClick={signIn}>{t('registration.signIn')}</Button>
      </div>
    );
  }
  if (!pending) return <div />;
  const [beforeEmail, afterEmail] = t('registration.sent', { email: '{email}' }).split('{email}');
  return (
    <div>
      <h1 className={`text-balance ${classNames.title}`}>{t('registration.checkEmail')}</h1>
      {status === 'expired' ? (
        // The code no longer applies, so a new email is the only way on.
        <>
          <p role="status" className="mt-3 text-sm text-[var(--uoa-color-text)]">{t('registration.expired')}</p>
          <Button type="button" className="mt-6" disabled={loading || resending} onClick={() => { void resend(); }}>
            {resending ? t('registration.sending') : t('registration.restart')}
          </Button>
        </>
      ) : (
        <>
          <p className="mt-3 text-sm text-[var(--uoa-color-text)]">{beforeEmail}<strong>{pending.email}</strong>{afterEmail}</p>
          <form className="mt-6 flex flex-col gap-4" aria-busy={loading} onSubmit={event => { event.preventDefault(); void submit(code); }}>
            <RegistrationCodeInput value={code} onChange={value => { setCode(value); setError(false); }}
              onComplete={value => { void submit(value); }} disabled={loading || resending} label={t('registration.code')}
              errorId={error ? 'registration-error' : undefined} />
            {error ? <p id="registration-error" role="alert" className="text-sm text-[var(--uoa-color-danger)]">{t('registration.error')}</p> : null}
            {loading ? <p role="status" className="text-sm text-[var(--uoa-color-muted)]">{t('registration.verifying')}</p> : null}
            {error ? <Button type="submit" disabled={loading}>{t('codeEntry.submit')}</Button> : null}
          </form>
          {resent ? <p role="status" className="mt-4 text-sm text-[var(--uoa-color-text)]">{t('registration.resent')}</p> : null}
          <button type="button" className={`mt-6 block ${TEXT_ACTION}`} disabled={loading || resending} onClick={() => { void resend(); }}>
            {resending ? t('registration.sending') : t('registration.resend')}
          </button>
        </>
      )}
      {sendError ? <p role="alert" className="mt-3 text-sm text-[var(--uoa-color-danger)]">{t('form.error.generic')}</p> : null}
      <button type="button" className={`mt-4 block ${TEXT_ACTION}`} onClick={changeEmail}>{t('registration.changeEmail')}</button>
    </div>
  );
}
