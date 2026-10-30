import { registrationTokenTtlHours } from '../../services/email.registration-copy.js';
import type { EndpointSchema } from './schema.js';

const context = {
  config_url: 'Required HTTPS signed website config URL, verified on every request',
  code_challenge: 'Required original 43-character S256 PKCE challenge',
  code_challenge_method: 'Required S256',
  redirect_url: 'Optional original registered callback',
  request_access: 'Optional original access-request flag',
};
const optIn = 'Only when the signed config sets login_flow.registration_code_enabled=true; otherwise 400 REGISTRATION_UNAVAILABLE (no row, email or counter).';
const browserAuth = 'Original registration-specific HttpOnly cookie, exact verified config and original OAuth context';

export const registrationVerificationEndpoints: EndpointSchema[] = [
  { method: 'POST', path: '/auth/registration/start', description: 'Begin browser-bound email registration; sends one neutral link/code email without exposing account state.',
    auth: `Verified config_url; same-origin browser request. ${optIn}`, query: context, body: { email: 'Email address' },
    response: { message: 'We sent instructions to your email', registration_id: 'Random public UUID; never sufficient authorization', expires_at: `${registrationTokenTtlHours()}-hour deadline; browser credential is only in Set-Cookie` },
    notes: 'The email is English or Czech by the request Accept-Language and states its lifetime in hours. Preserves the signed-config inline_sign_in opt-in (409 EMAIL_ALREADY_REGISTERED). Otherwise response shape is identical for new, existing, blocked and malformed addresses. Legacy POST /auth/register and /auth/start retain their existing contracts.' },
  { method: 'GET', path: '/auth/registration/status', description: 'Authoritative pending-registration state; safe to recheck after refresh, reconnect or notification. Only 400 REGISTRATION_UNAVAILABLE ends the flow; any other failure is passing, so keep polling.',
    auth: `${browserAuth}. ${optIn}`, query: { ...context, id: 'Pending registration UUID' },
    response: { status: 'pending | verified | authorized | complete | expired', token: 'Only when authorized: short-lived browser-bound completion proof', token_type: 'Only when authorized: LOGIN_LINK | VERIFY_EMAIL | VERIFY_EMAIL_SET_PASSWORD' } },
  { method: 'POST', path: '/auth/registration/code', description: 'Verify a six-character uppercase code only for the original requesting registration/browser. Five failed attempts exhaust it across replicas.',
    auth: `${browserAuth}. ${optIn}`, query: context, body: { id: 'Pending registration UUID', code: 'Six characters from ABCDEFGHJKLMNPQRSTUVWXYZ23456789; lowercase normalized' },
    response: { status: 'authorized', token: 'Browser-bound completion proof', token_type: 'Next existing email continuation type' } },
  { method: 'GET', path: '/auth/registration/events', description: 'Authenticated WebSocket upgrade; only non-secret verification hints. Database state remains authoritative.',
    auth: `${browserAuth}; exact canonical Origin. ${optIn}`, query: { ...context, id: 'Pending registration UUID' },
    response: { event: '{type:"registration.email_verified",status:"verified"}' },
    notes: 'Immediate process-local hints plus a 5-second cross-replica database recheck. Clients recheck status on load/reconnect and poll every 10 seconds if notifications are lost or WSS is blocked. Two subscriptions per registration and 256 per instance maximum.' },
  { method: 'GET', path: '/auth/registration/link', description: 'Isolated email confirmation page, usable on any browser/device. Link secret is in the fragment, removed immediately; GET has no verification effect.',
    auth: 'None; confirmation requires the secret token in POST', response: { html: 'Explicit confirmation, then email-verified success; never an OAuth redirect or login. English or Czech by the GET Accept-Language.' } },
  { method: 'POST', path: '/auth/registration/link', description: 'Confirm email from any device and approve continuation of the exact original pending registration, and of any later one for the same address from the same OAuth context (a resend). Returns restart_url when the signed config has login_restart_url.',
    auth: '256-bit email-link token; same-origin POST', body: { token: 'Secret from the emailed URL fragment' }, response: { status: 'verified', restart_url: 'Optional. The signed login_restart_url, for a person whose original window is gone.' },
    notes: 'The original browser receives a WebSocket hint, rechecks status with its cookie and exact OAuth context, and advances without code entry. The confirming browser receives no credentials, cookie or redirect. Replay cannot transfer approval to another flow. No account, OAuth code or session is created here.' },
];

export const registrationVerificationDocumentation = {
  enabled_by: 'Signed config login_flow.registration_code_enabled=true (default false). Off or absent: the hosted form keeps using POST /auth/register, and /auth/registration/start, /status, /code and /events answer 400 REGISTRATION_UNAVAILABLE. The /auth/registration/link page needs no flag.',
  endpoints: registrationVerificationEndpoints,
  completion: 'POST /auth/verify-email consumes an authorized registration. Namespaced registration.* proofs additionally require the original cookie and exact immutable OAuth/config context. Existing epoch, membership, TOTP, agreement and one-use issuance gates remain authoritative.',
  security: 'Explicit confirmation with the secret email link approves its original pending registration on any device. Only the original HttpOnly cookie and exact OAuth/config binding can retrieve and consume completion proof. The confirmation page explains this approval and never signs the confirming browser in. GET and link previews do not approve anything.',
};
