#!/usr/bin/env python3
"""Register a CKS binaries ISO as a CloudStack supported Kubernetes version.

The script is intentionally idempotent: if the semantic version already exists
in the target zone, it exits successfully without mutating the existing record.
CloudStack does not expose a general "replace this ISO URL/checksum" flow for a
supported version, so rebuilds of an already-registered patch should be treated
as exceptional and handled manually.
"""

from __future__ import annotations

import argparse
import os
import sys
from typing import Any

try:
    from cs import CloudStack
except ImportError as exc:  # pragma: no cover - exercised in CI shell, not unit tests.
    sys.exit("Missing dependency: pip install cs")


DEFAULT_ENDPOINT = "https://sky.runatlas.is/client/api"


def required_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        sys.exit(f"Missing required environment variable: {name}")
    return value


def supported_versions(payload: dict[str, Any]) -> list[dict[str, Any]]:
    for key in ("kubernetessupportedversion", "kubernetessupportedversions"):
        value = payload.get(key)
        if isinstance(value, list):
            return value
        if isinstance(value, dict):
            return [value]
    return []


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True, help="Kubernetes semantic version, e.g. 1.33.11")
    parser.add_argument("--url", required=True, help="Public URL of the CKS binaries ISO")
    parser.add_argument("--checksum", required=True, help="SHA-256 checksum of the ISO")
    parser.add_argument("--zone-id", required=True, help="CloudStack zone ID")
    parser.add_argument("--name", help="CloudStack display name, default: v<VERSION>")
    parser.add_argument("--min-cpu", type=int, default=int(os.environ.get("CKS_MIN_CPU", "2")))
    parser.add_argument("--min-memory", type=int, default=int(os.environ.get("CKS_MIN_MEMORY", "2048")))
    parser.add_argument(
        "--enable-existing",
        action="store_true",
        help="Re-enable an existing disabled supported version for this zone.",
    )
    args = parser.parse_args()

    endpoint = os.environ.get("CLOUDSTACK_ENDPOINT", DEFAULT_ENDPOINT)
    api_key = required_env("CLOUDSTACK_API_KEY")
    secret_key = required_env("CLOUDSTACK_SECRET_KEY")
    cs = CloudStack(endpoint=endpoint, key=api_key, secret=secret_key, timeout=120)

    existing = supported_versions(cs.listKubernetesSupportedVersion(listall=True))
    for item in existing:
        same_version = item.get("semanticversion") == args.version
        same_zone = item.get("zoneid") == args.zone_id
        if not (same_version and same_zone):
            continue

        item_id = item.get("id")
        state = str(item.get("state") or "Enabled")
        print(f"[cloudstack] v{args.version} already registered in zone {args.zone_id} ({item_id}, state={state})")
        if args.enable_existing and item_id and state.lower() == "disabled":
            cs.updateKubernetesSupportedVersion(id=item_id, state="Enabled")
            print(f"[cloudstack] re-enabled v{args.version}")
        return

    name = args.name or f"v{args.version}"
    result = cs.addKubernetesSupportedVersion(
        name=name,
        semanticversion=args.version,
        zoneid=args.zone_id,
        url=args.url,
        checksum=args.checksum,
        mincpunumber=args.min_cpu,
        minmemory=args.min_memory,
    )
    created = supported_versions(result)
    created_id = created[0].get("id") if created else "unknown"
    print(f"[cloudstack] registered {name} ({args.version}) in zone {args.zone_id}: {created_id}")


if __name__ == "__main__":
    main()
