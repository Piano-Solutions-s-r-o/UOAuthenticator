export const PUBLIC_ERROR_MESSAGE = 'Request failed';

// Brief 12: email tokens must be time-limited and one-time.
// TTL is implementation-defined; keep short by default.
export const EMAIL_TOKEN_TTL_MS = 30 * 60 * 1000;

// Registration can require switching to an email client and another browser tab.
// Keep this separate so password resets, 2FA resets, and invites stay short-lived.
export const REGISTRATION_EMAIL_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

// HUGO-2424: the one reminder to an unconfirmed registration goes out while the link has between
// these two bounds left. The upper bound keeps it from nagging right after sign-up. The lower
// bound is 1 h 30 min, not 2 h, because the reminder is also only sent 09:00-19:00 Prague time:
// with a 24 h link, a registration made around 11:00 reaches 2 h left at exactly 09:00 the next
// morning, a window of a single instant. The reminder window is 14.5 h long and the nightly gap in
// send hours is 14 h, so with 1 h 30 min every registration gets at least 30 minutes of eligible
// ticks, which one 5-minute tick cannot miss. The one exception is the Saturday before the clocks go
// back in October: that night is 15 h long, so registrations made between about 10:56 and 11:29
// CEST (about 34 minutes a year) get no reminder, and those from about 10:30 to 12:00 get less than
// 30 minutes. The owner accepted this. tests/unit/registration-reminder.test.ts pins its size.
export const REGISTRATION_REMINDER_MIN_REMAINING_MS = 90 * 60 * 1000;
export const REGISTRATION_REMINDER_MAX_REMAINING_MS = 16 * 60 * 60 * 1000;
// Europe/Prague local time, [start, end): 09:00 up to but not including 19:00.
export const REGISTRATION_REMINDER_SEND_START_HOUR = 9;
export const REGISTRATION_REMINDER_SEND_END_HOUR = 19;
export const REGISTRATION_REMINDER_TICK_MS = 5 * 60 * 1000;

// Brief 22.13: authorization codes must be short-lived (OAuth authorization code flow).
export const AUTHORIZATION_CODE_TTL_MS = 5 * 60 * 1000;

// Brief 13 / Phase 8.6: 2FA challenges during login must be short-lived bearer tokens.
export const TWOFA_CHALLENGE_TTL_MS = 5 * 60 * 1000;

// Two-factor enrollment setup tokens bridge setup -> initial TOTP verification.
export const TWOFA_SETUP_TTL_MS = 10 * 60 * 1000;

// Social OAuth state is signed and short-lived to limit replay window.
export const SOCIAL_STATE_TTL_MS = 10 * 60 * 1000;

// JWT `aud` claim for access tokens issued by this service.
export const ACCESS_TOKEN_AUDIENCE = 'uoa:access-token';

// Slack-style login (Phase 3b, design §4.3): a numeric sign-in code, hashed and stored like other
// VerificationToken rows, with a short TTL and a bounded attempt budget (login-code.service.ts).
export const LOGIN_CODE_TTL_MS = 10 * 60 * 1000;
export const LOGIN_CODE_MAX_ATTEMPTS = 5;

// Slack-style login (Phase 3b, design §4.3/§4.4): the `login_token` bridge JWT authorizes ONLY
// workspace selection for an already-verified user (same class as `twofa_token`) — never
// authentication by itself. JWT `aud` claim, mirroring ACCESS_TOKEN_AUDIENCE's fixed-audience shape.
export const LOGIN_SESSION_AUDIENCE = 'uoa:login-session';
export const LOGIN_SESSION_TTL_MS = 10 * 60 * 1000;

// Docs/Auth/avatars.md §3: uploaded avatars are raster-only (PNG/JPEG/WebP, magic-byte sniffed)
// and hard-capped at 1 MiB. Enforced after the multipart buffer is read, independently of the
// global @fastify/multipart fileSize limit, which is tuned for signature PDFs.
export const AVATAR_MAX_BYTES = 1024 * 1024;

// Docs/Auth/avatars.md §6: provider avatar URLs are proxied server-side so callers always get
// image bytes. The fetch is HTTPS-only, SSRF-guarded, time-capped and size-capped; any failure
// falls back to the generated avatar rather than surfacing an error.
//
// The budget is a deadline for the WHOLE operation — DNS resolution, every sequential address
// attempt, the fetch, and the streamed read — not a per-leg timeout. The URL is attacker-supplied,
// so a per-leg bound would let a host multiply the legs (slow DNS, then N addresses each stalling
// just under the cap) to occupy a request far longer than the number below suggests.
export const AVATAR_PROVIDER_DEADLINE_MS = 5_000;
export const AVATAR_PROVIDER_MAX_BYTES = 5 * 1024 * 1024;

// Cache lifetimes for avatar GET responses. Generated avatars are deterministic for a given
// user/style/size, so they get a long private lifetime; uploaded and proxied images can change.
export const AVATAR_DYNAMIC_CACHE_CONTROL = 'private, max-age=300';
export const AVATAR_GENERATED_CACHE_CONTROL = 'private, max-age=86400';
