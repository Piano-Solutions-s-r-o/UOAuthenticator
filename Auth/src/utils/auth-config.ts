export function isEmailPasswordEnabled(config: unknown): boolean {
  if (!config || typeof config !== 'object') return false;
  const methods = (config as Record<string, unknown>).enabled_auth_methods;
  return Array.isArray(methods) && methods.includes('email_password');
}

export function isRegistrationAllowed(config: unknown): boolean {
  if (!config || typeof config !== 'object') return true;
  return (config as Record<string, unknown>).allow_registration !== false;
}

/** Phase 3c (design §11.2): whether `/auth/start` also issues a 6-digit email sign-in code. */
export function isEmailCodeEnabled(config: unknown): boolean {
  if (!config || typeof config !== 'object') return false;
  const loginFlow = (config as Record<string, unknown>).login_flow;
  if (!loginFlow || typeof loginFlow !== 'object') return false;
  return (loginFlow as Record<string, unknown>).email_code_enabled === true;
}

/**
 * HUGO-2261: whether the product opted in (signed config `login_flow.registration_code_enabled`) to
 * browser-bound registration — an emailed code or a link confirmed on any device. Off or absent
 * keeps the original `/auth/register` link email and its confirmation screen.
 */
export function isRegistrationCodeEnabled(config: unknown): boolean {
  if (!config || typeof config !== 'object') return false;
  const loginFlow = (config as Record<string, unknown>).login_flow;
  if (!loginFlow || typeof loginFlow !== 'object') return false;
  return (loginFlow as Record<string, unknown>).registration_code_enabled === true;
}
