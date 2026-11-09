# Registration reminder (HUGO-2424)

One reminder e-mail to a registration nobody has confirmed. It exists for the browser-bound registration
(`login_flow.registration_code_enabled`, HUGO-2261). The original link-and-code e-mail is unchanged.

## Kill switch

`UOA_REGISTRATION_REMINDER_ENABLED` (default `false`). Off, nothing is scheduled and nothing is sent. On, every
instance runs a sweep every 5 minutes (`registration-reminder-scheduler.service.ts`, started in `app.ts`, not
in tests). It applies to the whole deployment, so on the shared Hugo SSO it reminds staging and production
registrations alike. Only products whose signed config opts in to HUGO-2261 have rows to remind, so enabling
it before that flag is on for production reminds staging registrations only.

## Who is reminded

A `PendingRegistration` row (`registration-reminder.service.ts`) when all of these hold:

- the link has between **1 h 30 min and 16 h** left, and Europe/Prague local time is in **[09:00, 19:00)**
  (`Intl`, so daylight saving is followed). The 1 h 30 min is not 2 h on purpose: with a 24 h link, a
  registration made around 11:00 would reach 2 h left at exactly 09:00 and have a one-instant window. At
  1 h 30 min the 14.5 h reminder window is longer than the 14 h gap in send hours, so every registration
  gets at least 30 minutes of eligible ticks, which a 5-minute tick cannot miss. **One exception, accepted
  by the owner:** the Saturday before the clocks go back in October. That night is 15 h long, so
  registrations made between about 10:56 and 11:29 CEST (about 34 minutes a year) get no reminder, and
  those from about 10:30 to 12:00 get less than 30 minutes. A unit test pins the size of this gap. The bounds are
  `REGISTRATION_REMINDER_*` in `config/constants.ts`;
- it is not completed, expired or out of attempts, its e-mail code was not verified, and its browser was not
  authorized. Opening the link does **not** count as confirming it, because mail scanners open links;
- its verification token is an unused `VERIFY_EMAIL_SET_PASSWORD` with no account behind it (an existing user
  is never reminded), and the address is not banned (the IP is not stored, so IP bans are not re-checked);
- it was never reminded, and it is its address's newest live registration (a resend is not a second person).

The legacy `POST /auth/register` link is never reminded: its PKCE challenge and `redirect_url` are not stored,
so a fresh link could not finish it.

## One family

The reminder does not add a row. It adds `reminderLinkHash` to the same row, and `POST /auth/registration/link`
accepts either hash. So the reminder shares the registration's expiry (never extended), its verification token
and its completion: finishing through either link completes the registration, and the other link then answers
`complete`. The original window follows as usual.

## One send

Per candidate, one transaction takes the per-address advisory lock a completion takes, rechecks everything, and
claims the row with `UPDATE ... WHERE reminder_sent_at IS NULL` (count 1 wins). The claim commits **before**
anything is sent. A code verified just after the claim commits still gets its reminder; that race is accepted. A failed send is logged at `warn` with the row id (never the address) and **not** retried:
at most one reminder, and zero is acceptable.

## What is stored

On `pending_registrations`, all nullable: `locale` (the registration e-mail's language, `en` when unknown),
`email_theme` (the product's e-mail theme, so the reminder looks the same without fetching the signed config),
`reminder_sent_at`, `reminder_link_hash`. Rows from before the migration have no locale or theme and are sent
in English with the default theme.

## Copy

`email.registration-copy.ts` (`registrationReminderCopy`) and `email.templates.registration-reminder.ts`: the
registration e-mail's card, logo and button, sent from `EMAIL_FROM`. The Czech is the owner's wording
verbatim. The English is a draft awaiting the owner's approval.
