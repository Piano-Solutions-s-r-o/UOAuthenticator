# Sign-up and sign-in funnel metrics

Added 2026-10-22 (HUGO-2166) so the owner can see where people sent to UOA by a product stop. The
trigger was Hugo: of the people Hugo sends to sso.hugopos.eu to register, a large share never come
back, and nothing in UOA recorded which step they left at. Verification tokens are pruned once they expire and registration
emails cannot be told apart per client in SES, so this cannot be reconstructed for the past;
measuring starts when this ships.

## What is recorded

One counter per **UTC day × client domain × step × outcome**, incremented once per event. The client
domain is the verified `domain` of the product's signed config. Nothing else is stored: no email,
IP address, user id, token, authorization code or flow id. Counts are events, not people: reloading
the window or submitting the form twice counts twice.

| Step | Recorded when | Outcomes |
| --- | --- | --- |
| `flow_started` | `GET /auth` renders the window for a product starting a flow. Mid-flow re-renders (2FA, workspace chooser, email-token continuations) and `HEAD` requests are not counted; a manual reload after the Auth window has stripped its continuation token can be. | `shown` (sign-in screen), `shown_register` (the product sent OIDC `prompt=create`, HUGO-1850, so the window opened on registration) |
| `register_submitted` | `POST /auth/register` and `POST /auth/registration/start` (the hosted "Create account" form uses the latter when the product opts in through `login_flow.registration_code_enabled`, otherwise the former). | `valid_email`, `invalid_email` |
| `email_start_submitted` | `POST /auth/start` (email-first form, products with email codes). | `valid_email`, `invalid_email` |
| `login_submitted` | `POST /auth/login` (email + password). | `succeeded` (credentials accepted; 2FA or a team choice may still follow), `failed` |
| `registration_email` | What UOA did with a submitted address behind the generic reply. `*_sent` means the email provider accepted the message, not that it arrived. | `verification_sent`, `verification_failed`, `login_link_sent`, `login_link_failed` (existing account), `existing_user_inline` (product opted into `inline_sign_in`; no email), `blocked` (registration not allowed or banned; no email), `error` |
| `email_link_opened` | `GET /auth/email/link`, the link in that email, or — for the browser-bound email — `POST /auth/registration/link`, which its landing page sends by itself. `HEAD` requests (mail scanners pre-checking links) are not counted. | `opened` (browser-bound link, first time), plus for both: `expired`, `already_used`, and from `GET /auth/email/link`: `valid_set_password`, `valid_verify_email`, `valid_login_link`, `invalid` (unknown, wrong client, or already pruned), `invalid_pkce` / `missing_pkce` (damaged link) |
| `set_password` | `POST /auth/verify-email` from the set-password form. | `succeeded` (set-password token: account created), `succeeded_<token type>` (another token type), `password_rejected`, `expired`, `already_used`, `failed` |
| `social_started` | `GET /auth/social/:provider` redirects to the provider. | provider key (`google`, `apple`, …) |
| `sign_in_completed` | A sign-in finished: UOA returned an authorization code or recorded an access request. Recorded next to every login-log write, so each password, email-link, email-code and social sign-in counts once, after any 2FA or workspace choice. Where the login log is written inside the authentication transaction, the counter is written after that transaction commits. | auth method (`email_password`, `verify_email_set_password`, `login_link`, `google`, `email_code`, …) |
| `registration_link_handoff` | `POST /auth/registration/link`, the first valid opening of a browser-bound link. Once per registration, resends included. | `opened` |
| `registration_password_set` | `POST /auth/verify-email`: a browser-bound registration got its password. Once per registration. | `link` (the browser that opened the link), `code` (the window that took the code) |
| `registration_completed` | `POST /auth/verify-email`: a browser-bound registration finished, including one for an address that already had an account. Once per registration. | `link`, `code` |
| `clicked_device_returned` | `POST /auth/verify-email`: the browser that opened the link was sent on, to the product or to a 2FA or workspace step. | `succeeded` |
| `original_device_returned` | The window where registration started was sent on, to the product or to a 2FA or workspace step. | `succeeded` (it took the code and finished itself), `continued` (`POST /auth/registration/continue`: the password was set elsewhere and it went in by itself) |
| `code_exchange` | The product backend redeems the code at `POST /auth/token` (`authorization_code` grant). | `succeeded`, `rejected_<reason>` (the internal reason behind the opaque `INVALID_AUTH_CODE`: `code_not_found`, `expired`, `already_used`, `pkce_verifier_invalid`, `redirect_url_mismatch`, …), `failed` |

Outcomes are server-chosen identifiers; anything that does not match `^[a-z0-9_]{1,64}$` is stored
as `other`. Public responses are unchanged: no outcome or rejection reason is ever returned to a
caller.

## Reading it

- **Admin:** Overview → **Sign-up funnel** (`/admin/signup-funnel`). Period (UTC) and service
  filters; a step table with how many reached each step, the share of opened windows, and every
  outcome; and a per-day table.
- **API:** `GET /internal/admin/auth-funnel?from=YYYY-MM-DD&to=YYYY-MM-DD&domain=<client domain>`
  with an admin-domain superuser bearer. Default range is the last 30 UTC days; at most 366 days.
  Contract in `/api`.

## Storage and failure behaviour

Table `auth_funnel_daily_counts`, primary key `(day, domain, step, outcome)`. It is admin-only like
the other log tables: forced RLS, deny-all policy and `REVOKE ALL` for `uoa_app`; written and read
through the BYPASSRLS admin client. Each event is one upsert-increment.

Recording is best-effort and never part of an authentication decision. It runs after the step's own
work, outside every authentication transaction, and a failed write is logged and swallowed, so a
metrics outage cannot change a sign-in outcome or response. A step waits at most one second for its
write; a slower write finishes in the background. The counters hold no personal data and
are not pruned.

## What a new person must do in UOA (as of 2026-10-22)

For Hugo on sso.hugopos.eu (`enabled_auth_methods: ["email_password", "google"]`, no
`registration_mode`, `existing_user_registration_behavior: "inline_sign_in"`, and Hugo sends
`prompt=create` for new customers):

1. Hugo opens `GET /auth?…&prompt=create`; the window opens on **registration** (HUGO-1850).
   is offered there as well.
2. Enter an email. UOA replies that it sent instructions (an address that already has an account is
   told to sign in instead).
3. Open the email and follow the link **within 24 hours** (`REGISTRATION_EMAIL_TOKEN_TTL_MS`). An
   expired, used or unknown link shows the sign-in screen again.
4. **Set a password** (at least 8 characters) on the screen the link opens. This creates the account.
5. UOA redirects back to Hugo with an authorization code; Hugo's backend exchanges it.

Each of those is a separate step above, so the funnel shows where people stop.

### Browser-bound verification (2026-10-22, reworked 2026-10-30)

With `login_flow.registration_code_enabled: true` and `registration_restart_url` in the signed config the hosted form uses `/auth/registration/start`; it records the same
`register_submitted` and `registration_email` counters through the same
`recordAuthFunnelStep` writer as `/auth/register` (a given submission uses one
endpoint, so nothing is counted twice). Its link and code last 24
hours (`REGISTRATION_EMAIL_TOKEN_TTL_MS`). `POST /auth/registration/link` records `email_link_opened` once per open, outside its transaction: `opened` the first time, `already_used` afterwards, `expired` for an expired or exhausted registration. A GET, a HEAD or a
status/WebSocket subscription never counts. Opening proves nothing by itself: the funnel's
real step is `set_password`.
Code verification is an alternative to opening the link and does not increment
the link counter. Both methods reach the existing `set_password`,
`sign_in_completed` and `code_exchange` writers. The product's return to `/auth` with a handoff
cookie of a live registration continues one already counted, so it is not a `flow_started`; a cookie
of a finished registration opens nothing and counts as an ordinary start.
When the original window then goes in by itself it records `original_device_returned` with
`continued` and, once it gets a code, a second `sign_in_completed`: it is a real sign-in of a second
browser, so subtract that outcome to count people. The other counters here are events, not people.
The five registration steps are the exception: each counts one registration once, so the way to
read the funnel is `registration_email`, `registration_link_handoff`, `registration_password_set`,
`registration_completed`, then the two `*_device_returned` steps.
