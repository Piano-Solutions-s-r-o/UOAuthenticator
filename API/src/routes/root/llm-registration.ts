import { registrationTokenTtlHours } from '../../services/email.registration-copy.js';

export const llmRegistrationMarkdown = `
## Browser-bound registration verification

This flow is opt-in per product: it is used only when the signed config sets
\`login_flow.registration_code_enabled: true\` and \`registration_restart_url\`. Without
both (the default), the Create account form keeps using POST /auth/register and its link
email, and /auth/registration/start, /status, /code, /continue and /events answer 400
REGISTRATION_UNAVAILABLE without creating a row or sending an email. The link page below
needs no flag: its tokens exist only for registrations started with the flow on.

The hosted registration screen uses POST /auth/registration/start with {email},
the verified config_url and original OAuth context (S256 challenge, callback
and access-request flag). Its generic response includes registration_id
and expires_at for every ordinary account/eligibility outcome; the signed
inline_sign_in opt-in still permits EMAIL_ALREADY_REGISTERED. A ${registrationTokenTtlHours()}-hour,
registration-specific HttpOnly cookie owns the flow. Public IDs are not credentials.

The email contains a secret link and a six-character code. Codes use
ABCDEFGHJKLMNPQRSTUVWXYZ23456789, are hashed with a server pepper, and allow five
persisted guesses per registration. The email and the link page are English or
Czech, chosen from the Accept-Language of the request that produced them; the email
states its lifetime in hours and shows the address being registered.

The link: finish where it is clicked. GET /auth/registration/link is an isolated
page. Its URL fragment holds the 256-bit secret, so the secret never reaches access
logs or referrers. The page removes the fragment and posts it at once.
POST /auth/registration/link with {token} approves nothing and creates nothing, and
returns {status, next}:
- "continue" for a live, unfinished set-password registration: the response sets the
  handoff cookie and next is your registration_restart_url. The page goes there.
- "complete" for a finished registration, or an address that already has an account:
  next is your login_restart_url, absent if you have none.
- "expired" for an expired or exhausted registration: next is your
  registration_restart_url.
Unknown or malformed tokens answer 400. Mail scanners cost nothing: GET and HEAD have
no effect, and one that runs the page only gets a cookie in its own browser.

The handoff cookie uoa_registration_handoff is signed, HttpOnly, SameSite=Lax,
Path=/auth, host-only and Secure on https. It lasts 15 minutes, never past the
registration, holds the registration id and two times and no secret or address, and a
link may reissue it until completion. Your registration_restart_url must start your
normal sign-in with fresh state and PKCE, in the browser it runs in, and return to
/auth. /auth then opens the password form for that registration when the cookie
verifies, S256 PKCE is present and the row is live, unfinished, on the same domain and
on the exact same signed config. It bootstraps only the display address. Anything
else ignores the cookie and shows the normal view; /auth without PKCE still shows the
login_restart_url prompt. This wins over prompt=create.

The password form calls POST /auth/verify-email with {password} and no token. The
server resolves the existing verification token (a second one would race the rule
that one pre-user token exists) and consumes it, and the authorization code is bound
to this browser's own PKCE. All the usual workspace, 2FA and epoch checks run.

A forwarded link puts whoever opens it into the sender's account. The password screen
shows the address for that reason, and the email says not to click a registration you
do not recognise.

The code: finish in the original window. POST /auth/registration/code accepts {id,code}
only with that browser's cookie and exact original OAuth/config context. Status then
answers authorized with a namespaced registration.* completion proof and token_type,
and POST /auth/verify-email performs password setup or the existing login continuation.
Those proofs additionally require the original cookie and immutable OAuth/config
binding.

Completion marks the resend family complete in the transaction that spends the token:
registrations of the same address from the same browser and OAuth context, so a link
from an older email finishes the window on the newest one. A resend proves the browser
by sending previous_id to /auth/registration/start with that registration's cookie.
The older token is the one spent; the newer one dies through the epoch check. Another
address or browser is never touched. When two browsers race, the first password wins
and the other gets a generic failure.

The original window, finished elsewhere. When status says complete the window calls
POST /auth/registration/continue with {id}. Under the row lock that requires the
window's cookie and exact context, completion within the last 15 minutes and no earlier
continuation, and rechecks the user and credential epoch. It then runs the same
workspace, 2FA and code issuance as /auth/verify-email, bound to the window's own PKCE,
so if 2FA is needed it answers the normal 2FA step. It works once for the family, and
never when the window finished itself. On any failure show sign-in. Status never
carries a code, so polling cannot sign anyone in.

GET /auth/registration/status and authenticated WSS /auth/registration/events
require the original cookie plus exact signed config and OAuth context; WSS
additionally requires the exact service Origin. Events contain only
{type:"registration.changed"} and are sent for authorized and complete; the socket
closes after a complete hint and on expired. Clients treat them as
hints and re-read database state on load, reconnect and focus. Only a 400 with
code REGISTRATION_UNAVAILABLE ends the flow: a bare 400 (a failed config fetch),
429 or 5xx is passing, so keep polling. Process-local
events are immediate; connected replicas recheck the database every five seconds.
A ten-second client poll covers blocked WSS and lost hints. Refresh persists
only the public pending ID and display email; credentials remain HttpOnly.

Status is pending, authorized, complete or expired. Registration codes and
link secrets must never be logged. Expired pending records are pruned.
Legacy POST /auth/register and /auth/start retain their existing contracts.
See GET /api for the full machine-readable endpoint schema.
`;
