import React from 'react';

import { usePopup } from '../../hooks/use-popup.js';
import { useTheme } from '../../hooks/use-theme.js';
import { useTranslation } from '../../i18n/use-translation.js';

// Forwarded login options come from the partner's signed config
// (`forward_auth_methods`). Unlike social providers, UOA runs no OAuth for these
// — each is rendered as a "Continue with <label>" button that top-level-navigates
// the authenticator window to the partner's own URL, where the partner completes
// login and mints its own session. This mirrors SocialButtons' plain-<a> model:
// control leaves via a top-level navigation, not window.opener/postMessage.

type ForwardMethod = { id: string; label: string; url: string };

function readForwardMethods(config: unknown): ForwardMethod[] {
  if (!config || typeof config !== 'object') return [];

  const c = config as Record<string, unknown>;
  const raw = Array.isArray(c.forward_auth_methods) ? c.forward_auth_methods : [];

  const methods: ForwardMethod[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const id = typeof e.id === 'string' ? e.id : '';
    const label = typeof e.label === 'string' ? e.label : '';
    const url = typeof e.url === 'string' ? e.url : '';
    // The config JWT is signed, but defend the render path too: only emit
    // absolute http(s) targets so a malformed entry can't inject javascript:.
    if (!id || !label || !/^https?:\/\//i.test(url)) continue;
    methods.push({ id, label, url });
  }
  return methods;
}

function ForwardIcon(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
      <polyline points="10 17 15 12 10 7" />
      <line x1="15" y1="12" x2="3" y2="12" />
    </svg>
  );
}

export function ForwardButtons(props?: { showDivider?: boolean }): React.JSX.Element | null {
  const popup = usePopup();
  const { classNames } = useTheme();
  const { t } = useTranslation();
  const showDivider = props?.showDivider ?? false;

  const methods = readForwardMethods(popup.config);
  if (methods.length === 0) return null;

  return (
    <div className="flex flex-col gap-3">
      {showDivider ? (
        <div className="flex items-center gap-3 text-[var(--uoa-color-muted)]">
          <div className="h-px flex-1 bg-[var(--uoa-color-border)]" />
          <span className="text-xs uppercase tracking-wider">{t('social.divider')}</span>
          <div className="h-px flex-1 bg-[var(--uoa-color-border)]" />
        </div>
      ) : null}
      {methods.map((method) => (
        <a key={method.id} href={method.url} className={classNames.buttonSecondary}>
          <ForwardIcon />
          {t('social.continueWith')} {method.label}
        </a>
      ))}
    </div>
  );
}
