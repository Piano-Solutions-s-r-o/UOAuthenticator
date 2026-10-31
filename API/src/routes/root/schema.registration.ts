import { registrationTokenTtlHours } from '../../services/email.registration-copy.js';
import type { EndpointSchema } from './schema.js';

const context = {
  config_url: 'Required HTTPS signed website config URL, verified on every request',
  code_challenge: 'Required original 43-character S256 PKCE challenge',
  code_challenge_method: 'Required S256',
  redirect_url: 'Optional original registered callback',
  request_access: 'Optional original access-request flag',
};
const optIn = 'Only when the signed config sets login_flow.registration_code_enabled=true and registration_restart_url; otherwise 400 REGISTRATION_UNAVAILABLE (no row, email or counter).';
const browserAuth = 'Original registration-specific HttpOnly cookie, exact verified config and original OAuth context';

export const registrationVerificationEndpoints: EndpointSchema[] = [
  { method: 'POST', path: '/auth/registration/start', description: 'Begin browser-bound email registration; sends one neutral link/code email without exposing account state.',
    auth: `Verified config_url; same-origin browser request. ${optIn}`, query: context, body: { email: 'Email address', previous_id: 'Optional, on a resend: the registration this one replaces. With its cookie, both stay bound to this browser.' },
    response: { message: 'We sent instructions to your email', registration_id: 'Random public UUID; never sufficient authorization', expires_at: `${registrationTokenTtlHours()}-hour deadline; browser credential is only in Set-Cookie` },
    notes: 'The email is English or Czech by the request Accept-Language and states its lifetime in hours. Preserves the signed-config inline_sign_in opt-in (409 EMAIL_ALREADY_REGISTERED). Otherwise response shape is identical for new, existing, blocked and malformed addresses. Legacy POST /auth/register and /auth/start retain their existing contracts.' },
  { method: 'GET', path: '/auth/registration/status', description: 'Authoritative pending-registration state; safe to recheck after refresh, reconnect or notification. Only 400 REGISTRATION_UNAVAILABLE ends the flow; any other failure is passing, so keep polling.',
    auth: `${browserAuth}. ${optIn}`, query: { ...context, id: 'Pending registration UUID' },
    response: { status: 'pending | authorized | complete | expired', token: 'Only when authorized: short-lived browser-bound completion proof', token_type: 'Only when authorized: LOGIN_LINK | VERIFY_EMAIL | VERIFY_EMAIL_SET_PASSWORD' } },
  { method: 'POST', path: '/auth/registration/code', description: 'Verify a six-character uppercase code only for the original requesting registration/browser. Five failed attempts exhaust it across replicas.',
    auth: `${browserAuth}. ${optIn}`, query: context, body: { id: 'Pending registration UUID', code: 'Six characters from ABCDEFGHJKLMNPQRSTUVWXYZ23456789; lowercase normalized' },
    response: { status: 'authorized', token: 'Browser-bound completion proof', token_type: 'Next existing email continuation type' } },
  { method: 'POST', path: '/auth/registration/continue', description: 'The original window, after status says complete: go in without a password. Same cookie and exact context as the rest of the flow, within 15 minutes of completion, once per registration family, and never when the window finished itself. Rechecks the user and the credential epoch, then runs the workspace, 2FA and code issuance of ordinary verification, bound to this window\'s own PKCE.',
    auth: `${browserAuth}; same-origin browser request. ${optIn}`, query: context, body: { id: 'Pending registration UUID' },
    response: { code: 'Authorization code, as POST /auth/verify-email answers', redirect_to: 'Redirect URL', twofa_required: 'Or the same 2FA and workspace outcomes as POST /auth/verify-email' },
    notes: 'A generic 400 REGISTRATION_UNAVAILABLE for every refusal; 401 when the credentials changed since completion. Show sign-in instead. Status never carries a code.' },
  { method: 'GET', path: '/auth/registration/events', description: 'Authenticated WebSocket upgrade; only non-secret change hints. Database state remains authoritative.',
    auth: `${browserAuth}; exact canonical Origin. ${optIn}`, query: { ...context, id: 'Pending registration UUID' },
    response: { event: '{type:"registration.changed"}, sent for authorized and complete. The socket closes after a complete hint and on expired.' },
    notes: 'Immediate process-local hints plus a 5-second cross-replica database recheck. Clients recheck status on load/reconnect and poll every 10 seconds if notifications are lost or WSS is blocked. Two subscriptions per registration and 256 per instance maximum.' },
  { method: 'GET', path: '/auth/registration/link', description: 'Isolated email landing page, usable on any browser/device. The link secret is in the fragment; the page removes it and posts it at once. GET and HEAD have no effect.',
    auth: 'None; the page posts the secret token', response: { html: 'A short status line, then the next step. English or Czech by the GET Accept-Language.' } },
  { method: 'POST', path: '/auth/registration/link', description: 'Open an emailed link. Approves nothing and creates nothing. For a live, unfinished set-password registration it sets the handoff cookie and sends the browser to registration_restart_url, where the product starts fresh PKCE. Back at /auth that cookie opens the password form for this registration.',
    auth: '256-bit email-link token; same-origin POST', body: { token: 'Secret from the emailed URL fragment' },
    response: { status: 'continue | complete | expired', next: 'continue and expired: the signed registration_restart_url. complete: the signed login_restart_url, absent when the product has none.' },
    notes: 'complete covers a finished registration and an address that already has an account. expired covers an expired or exhausted row. Unknown or malformed tokens answer 400, and so does a link 30 days past its expiry, when its row is pruned. Handoff cookie uoa_registration_handoff: signed, HttpOnly, SameSite=Lax, Path=/auth, not cleared on completion, host-only, Secure on https, one hour and never past the registration; it holds the registration id and two times, no secret and no address. A link may reissue it until completion. Rate limited per link and, widely, per address.' },
];

export const registrationVerificationDocumentation = {
  enabled_by: 'Signed config login_flow.registration_code_enabled=true (default false) plus registration_restart_url. Without both: the hosted form keeps using POST /auth/register, and /auth/registration/start, /status, /code, /continue and /events answer 400 REGISTRATION_UNAVAILABLE. The /auth/registration/link page needs no flag.',
  endpoints: registrationVerificationEndpoints,
  completion: 'POST /auth/verify-email finishes a registration in one of two ways: in the browser that opened the link, with its handoff cookie and no token, under exact config and domain and with that browser\'s own fresh PKCE; or in the original window, where a namespaced registration.* proof requires the original cookie and exact OAuth/config context. Completion marks the resend family (same address, browser secret and OAuth context) in the transaction that spends the token. Existing epoch, membership, TOTP, agreement and one-use issuance gates remain authoritative.',
  security: 'Opening the secret email link approves nothing. Whoever opens it can set the password, so a forwarded link puts the opener into the sender\'s account: the password screen shows the address for that reason, and the email says not to click a registration you do not recognise. The original window, holding its cookie and exact context, may go in by itself for 15 minutes after the password was set. GET and link previews do nothing; a scanner that runs the page gets only a cookie in its own browser.',
};
