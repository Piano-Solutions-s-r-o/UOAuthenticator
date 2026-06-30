#!/usr/bin/env python3
"""Upsert EMAIL_FROM into the hugo-sso DigitalOcean App Platform spec.

Reads a `doctl apps spec get` YAML file (path = argv[1]), upserts the EMAIL_FROM
env var into the target service ONLY (preserving every other field, including any
existing encrypted `EV[1:...]` secret refs and the SES wiring), and writes the spec
back in place. The value comes from EMAIL_FROM_VALUE in the environment (injected
from the workflow input); it is a sender address such as `Hugo <noreply@hugopos.eu>`,
not a credential, so it is stored as a GENERAL (plaintext) env var.

Service selection: if the spec has exactly one service, that one is used. Otherwise
set TARGET_SERVICE to the service name. HUGO-553.
"""
import os
import sys

import yaml

TARGET_KEY = "EMAIL_FROM"


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


def main():
    path = sys.argv[1]
    with open(path) as fh:
        spec = yaml.safe_load(fh)
    if not isinstance(spec, dict):
        sys.exit("spec is not a mapping — refusing to touch it")

    value = os.environ.get("EMAIL_FROM_VALUE")
    if not value:
        sys.exit("EMAIL_FROM_VALUE not provided — refusing to update")

    svc = pick_service(spec)
    envs = svc.setdefault("envs", [])
    before = len(envs)
    envs[:] = [e for e in envs if e.get("key") != TARGET_KEY]
    envs.append({"key": TARGET_KEY, "value": value, "scope": "RUN_TIME", "type": "GENERAL"})
    print(f"  upsert {TARGET_KEY} (GENERAL) on service '{svc.get('name')}'")

    # safety: never shrink the env list, never lose the service
    if len(envs) < before:
        sys.exit("env list shrank unexpectedly — aborting")

    with open(path, "w") as fh:
        yaml.safe_dump(spec, fh, sort_keys=False)
    print("service env keys now:", sorted({e.get("key") for e in envs}))


if __name__ == "__main__":
    main()
