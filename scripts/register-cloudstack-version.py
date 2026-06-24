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
import re
from typing import Any

try:
    from cs import CloudStack
except ImportError as exc:  # pragma: no cover - exercised in CI shell, not unit tests.
    sys.exit("Missing dependency: pip install cs")


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


def cloudstack_checksum(value: str) -> str:
    checksum = value.strip()
    if re.fullmatch(r"\{[^}]+\}[0-9a-fA-F]+", checksum):
        return checksum
    if re.fullmatch(r"[0-9a-fA-F]{64}", checksum):
        return "{SHA-256}" + checksum.lower()
    if re.fullmatch(r"[0-9a-fA-F]{32}", checksum):
        return checksum.lower()
    sys.exit(
        "Checksum must be a 64-character SHA-256 hex digest, a 32-character "
        "MD5 hex digest, or a CloudStack-prefixed value such as {SHA-256}<hex>"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True, help="Kubernetes semantic version, e.g. 1.33.11")
    parser.add_argument("--url", required=True, help="Public URL of the CKS binaries ISO")
    parser.add_argument("--checksum", required=True, help="SHA-256 checksum of the ISO")
    parser.add_argument("--zone-id", required=True, help="CloudStack zone ID")
    parser.add_argument("--name", help="CloudStack display name, default: v<VERSION>")
    parser.add_argument("--arch", default=os.environ.get("CKS_ARCH", "x86_64"), choices=("x86_64", "aarch64"))
    parser.add_argument("--min-cpu", type=int, default=int(os.environ.get("CKS_MIN_CPU", "2")))
    parser.add_argument("--min-memory", type=int, default=int(os.environ.get("CKS_MIN_MEMORY", "2048")))
    parser.add_argument(
        "--direct-download",
        action="store_true",
        default=os.environ.get("CKS_DIRECT_DOWNLOAD", "").lower() == "true",
        help="Register the ISO for direct primary-storage download on KVM.",
    )
    parser.add_argument(
        "--enable-existing",
        action="store_true",
        help="Re-enable an existing disabled supported version for this zone.",
    )
    parser.add_argument("--dry-run", action="store_true", help="Print the intended CloudStack mutation without applying it.")
    args = parser.parse_args()

    endpoint = required_env("CLOUDSTACK_ENDPOINT")
    api_key = required_env("CLOUDSTACK_API_KEY")
    secret_key = required_env("CLOUDSTACK_SECRET_KEY")
    cs = CloudStack(endpoint=endpoint, key=api_key, secret=secret_key, timeout=120)

    existing = supported_versions(cs.listKubernetesSupportedVersions(zoneid=args.zone_id, arch=args.arch))
    for item in existing:
        same_version = item.get("semanticversion") == args.version
        same_zone = item.get("zoneid") == args.zone_id
        same_arch = not item.get("arch") or item.get("arch") == args.arch
        if not (same_version and same_zone and same_arch):
            continue

        item_id = item.get("id")
        state = str(item.get("state") or "Enabled")
        print(f"[cloudstack] v{args.version} already registered in zone {args.zone_id} ({item_id}, state={state})")
        if args.enable_existing and item_id and state.lower() == "disabled":
            if args.dry_run:
                print(f"[cloudstack] dry-run: would re-enable v{args.version}")
                return
            cs.updateKubernetesSupportedVersion(id=item_id, state="Enabled")
            print(f"[cloudstack] re-enabled v{args.version}")
        return

    name = args.name or f"v{args.version}"
    checksum = cloudstack_checksum(args.checksum)
    if args.dry_run:
        print(
            "[cloudstack] dry-run: would register "
            f"{name} ({args.version}, arch={args.arch}) in zone {args.zone_id}: {args.url}"
        )
        return
    result = cs.addKubernetesSupportedVersion(
        name=name,
        semanticversion=args.version,
        zoneid=args.zone_id,
        url=args.url,
        checksum=checksum,
        arch=args.arch,
        mincpunumber=args.min_cpu,
        minmemory=args.min_memory,
        directdownload=args.direct_download,
    )
    created = supported_versions(result)
    created_id = created[0].get("id") if created else "unknown"
    print(f"[cloudstack] registered {name} ({args.version}) in zone {args.zone_id}: {created_id}")


if __name__ == "__main__":
    main()
