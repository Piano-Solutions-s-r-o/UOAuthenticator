#!/usr/bin/env python3
"""Upsert Sign in with Apple env vars into the hugo-sso DO App Platform spec.

Reads a `doctl apps spec get` YAML file (path = argv[1]), upserts the Apple env
vars into the target service ONLY, preserving every other field. Values come
from GitHub Actions secrets exposed as environment variables by the workflow.

Service selection: if the spec has exactly one service, that one is used.
Otherwise set TARGET_SERVICE to the service name. HUGO-570.
"""
import os
import sys

import yaml

# (key, DO env type, required). APPLE_DOMAIN_ASSOCIATION is optional: Apple's
# current Services-ID web-auth flow verifies the domain via the registered
# Return URL, so the domain-association file is not needed. It is upserted only
# when the value is provided.
APPLE_ENVS = [
    ("APPLE_PRIVATE_KEY", "SECRET", True),
    ("APPLE_CLIENT_ID", "SECRET", True),
    ("APPLE_TEAM_ID", "SECRET", True),
    ("APPLE_KEY_ID", "SECRET", True),
    ("APPLE_DOMAIN_ASSOCIATION", "GENERAL", False),
]


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

    missing = [key for key, _type, required in APPLE_ENVS if required and not os.environ.get(key)]
    if missing:
        sys.exit(f"missing required env values: {', '.join(missing)} — refusing to update")

    # Upsert only the keys actually provided; optional keys left unset are not
    # touched (so an absent APPLE_DOMAIN_ASSOCIATION neither adds nor removes it).
    provided = [(key, env_type) for key, env_type, _required in APPLE_ENVS if os.environ.get(key)]

    svc = pick_service(spec)
    envs = svc.setdefault("envs", [])
    before = len(envs)
    target_keys = {key for key, _type in provided}
    envs[:] = [e for e in envs if e.get("key") not in target_keys]

    for key, env_type in provided:
        envs.append(
            {
                "key": key,
                "value": os.environ[key],
                "scope": "RUN_TIME",
                "type": env_type,
            }
        )
        print(f"  upsert {key} ({env_type}) on service '{svc.get('name')}'")

    # safety: never shrink the env list, never lose the service
    if len(envs) < before:
        sys.exit("env list shrank unexpectedly — aborting")

    with open(path, "w") as fh:
        yaml.safe_dump(spec, fh, sort_keys=False)
    print("service env keys now:", sorted({e.get("key") for e in envs}))


if __name__ == "__main__":
    main()
