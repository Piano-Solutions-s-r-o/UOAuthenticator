#!/usr/bin/env python3
"""Switch the transactional-mail provider on the hugo-sso DigitalOcean App
Platform spec (UOA / SSO service).

HUGO-612 — temporary bridge: route UOA's transactional mail (sign-in link,
registration invite, etc.) through SendGrid while AWS SES is still sandboxed
(SES only delivers to verified recipients). SendGrid gates the *sender*, not the
recipient; piano.cz is already domain-authenticated in the SendGrid account, so
`Hugo <hugo@piano.cz>` sends to anyone. UOA's SendGrid provider uses the
`@sendgrid/mail` SDK, which accepts a `"Name <email>"` from value as-is.

Reversible by design: the provider is a single env var. Re-run with
PROVIDER=ses to fall straight back to SES (its AWS creds stay in the spec)
once SES production access is granted.

Reads a `doctl apps spec get` YAML file (path = argv[1]) and, on the target
service ONLY (preserving every other field incl. existing encrypted EV[1:...]
secret refs and the SES wiring):

  PROVIDER=sendgrid  -> EMAIL_PROVIDER=sendgrid (GENERAL)
                        EMAIL_FROM=<EMAIL_FROM_VALUE env> (GENERAL)
                        SENDGRID_API_KEY=<SENDGRID_API_KEY env> (SECRET)
  PROVIDER=ses       -> EMAIL_PROVIDER=ses (GENERAL)   [revert; leaves the
                        SendGrid key/from in place, unused, harmless]

Service selection mirrors inject_email_from.py: single service is auto-picked,
otherwise set TARGET_SERVICE. Values come from the environment (injected from
GitHub secrets/inputs) and are NEVER printed — only key names + types are logged.
"""
import os
import sys

import yaml

VALID_PROVIDERS = ("sendgrid", "ses")


def pick_service(spec):
    services = spec.get("services") or []
    if not services:
        sys.exit("spec has no services — refusing to update")
    wanted = os.environ.get("TARGET_SERVICE")
    if wanted:
        svc = next((s for s in services if s.get("name") == wanted), None)
        if svc is None:
            sys.exit(f"service '{wanted}' not found in spec — refusing to update")
        return svc
    if len(services) == 1:
        return services[0]
    names = ", ".join(s.get("name", "?") for s in services)
    sys.exit(f"multiple services ({names}); set TARGET_SERVICE to choose one")


def upsert(envs, key, value, typ):
    envs[:] = [e for e in envs if e.get("key") != key]
    envs.append({"key": key, "value": value, "scope": "RUN_TIME", "type": typ})
    if typ == "SECRET":
        print(f"  upsert {key} ({typ})")
    else:
        print(f"  upsert {key} ({typ}) = {value}")


def main():
    path = sys.argv[1]
    provider = (os.environ.get("PROVIDER") or "").strip().lower()
    if provider not in VALID_PROVIDERS:
        sys.exit(f"PROVIDER must be one of {VALID_PROVIDERS}, got '{provider}'")

    with open(path) as fh:
        spec = yaml.safe_load(fh)
    if not isinstance(spec, dict):
        sys.exit("spec is not a mapping — refusing to touch it")

    svc = pick_service(spec)
    envs = svc.setdefault("envs", [])
    before = len(envs)

    upsert(envs, "EMAIL_PROVIDER", provider, "GENERAL")

    if provider == "sendgrid":
        email_from = os.environ.get("EMAIL_FROM_VALUE")
        if not email_from:
            sys.exit("EMAIL_FROM_VALUE is required when PROVIDER=sendgrid")
        api_key = os.environ.get("SENDGRID_API_KEY")
        if not api_key:
            sys.exit("SENDGRID_API_KEY is required when PROVIDER=sendgrid")
        upsert(envs, "EMAIL_FROM", email_from, "GENERAL")
        upsert(envs, "SENDGRID_API_KEY", api_key, "SECRET")

    # safety: never shrink the env list, never lose the service
    if len(envs) < before:
        sys.exit("env list shrank unexpectedly — aborting")

    with open(path, "w") as fh:
        # width huge → NEVER line-wrap: wrapping a long secret / a value with
        # spaces can corrupt it on the doctl round-trip and fail the health
        # check. allow_unicode keeps values byte-faithful.
        yaml.safe_dump(spec, fh, sort_keys=False, width=1_000_000, allow_unicode=True)
    print(
        f"'{svc.get('name')}' env keys now:",
        sorted({e.get("key") for e in envs}),
    )


if __name__ == "__main__":
    main()
