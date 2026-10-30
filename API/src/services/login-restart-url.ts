import { REDIRECT_LOOPBACK_HOSTS } from '../utils/http-url.js';

/** A restart URI is client initiation, not an authorization callback or token grant. */
export function isValidLoginRestartUrl(value: string, redirects: string[]): boolean {
  try {
    const url = new URL(value);
    // The scheme check is what keeps javascript:/data: out: their origin is the opaque "null".
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && REDIRECT_LOOPBACK_HOSTS.has(url.hostname))) {
      return false;
    }
    if (url.username || url.password || url.hash) return false;
    // A custom-scheme redirect (com.acme.app://cb) also has origin "null", so it never vouches for one.
    return redirects.some((redirect) => {
      const origin = new URL(redirect).origin;
      return origin !== 'null' && origin === url.origin;
    });
  } catch {
    return false;
  }
}
