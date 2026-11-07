# Hugo registration with code and any-device link — 23 October 2026

HUGO-2261. Upstream #123, #124 and #129 ported to the fork, then Hugo's
specification: 24 h validity, Czech copy in informal "ty", the email and the
isolated confirmation page in English or Czech by `Accept-Language`, HUGO-1858
"Back to sign in" kept on the code screen, and the whole flow behind
`login_flow.registration_code_enabled` (absent = the original `/auth/register`
link flow, unchanged).

Screenshots from the registration Playwright flow (`PW_CHANNEL=chrome`,
desktop 1024×768 and Pixel 7). The test theme is not Hugo's yellow theme.

| File | Screen |
| --- | --- |
| `*-czech-registration.png` | Code screen in Czech, with "Zpět na přihlášení" |
| `*-after-email-cs.png` | Czech verification email: button, code, 24 h validity |
| `*-link-cs-confirmation.png` | Isolated confirmation page in Czech |
| `*-link-cs-success.png` | Confirmation success in Czech |
| `*-link-cs-error.png` | Rejected link in Czech (button removed) |
| `*-original-flow-sent.png` | Switch off: the original `/auth/register` confirmation |
