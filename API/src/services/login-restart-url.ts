/** A restart URI is client initiation, not an authorization callback or token grant. */
export function isValidLoginRestartUrl(value: string, redirects: string[]): boolean {
  try {
    const url = new URL(value);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return false;
    if (url.username || url.password || url.hash) return false;
    return redirects.some((redirect) => new URL(redirect).origin === url.origin);
  } catch {
    return false;
  }
}
