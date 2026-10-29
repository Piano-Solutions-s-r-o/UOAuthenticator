# Sign-in failure and pause messages — 24 October 2026 (HUGO-2288)

The sign-in form used to answer every failed `POST /auth/login` with "Invalid email or
password.", including the 429 the rate limiter returns after five attempts for one address in
15 minutes (or ten per IP per minute). On Hugo production 14 of 20 password sign-ins failed in
the first day of funnel data, and one person kept retrying through eight 429s while being told
the password was wrong.

- 429 → "Too many attempts in a row, so sign-in is paused …" (`form.login.rateLimited`).
- Any other failure → owner-approved copy that points at Create account and Forgot your
  password (`form.login.error`), or the previous plain text (`form.login.errorPlain`) where
  registration is off and Create account is not rendered (including MCP).
- The server response is unchanged, so a wrong password and an unknown address still look the
  same; the limiter counts the typed address before any account lookup, so a 429 reveals nothing.

Screenshots: Playwright with system Chrome, `/auth/login` mocked to 401 and 429, a Hugo-like
theme (Create account as a secondary button), Pixel 7 and 1280×800.
