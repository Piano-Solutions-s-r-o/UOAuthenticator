/** Read only from the server-verified config, never a query parameter. */
export function loginRestartUrl(config: unknown): string | null {
  if (!config || typeof config !== 'object') return null;
  const value = (config as Record<string, unknown>).login_restart_url;
  return typeof value === 'string' && value ? value : null;
}
