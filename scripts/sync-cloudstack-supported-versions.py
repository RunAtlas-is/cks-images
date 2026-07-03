#!/usr/bin/env python3
"""Sync published CKS images into CloudStack supported Kubernetes versions.

The sync model is intentionally pull-based: run this inside the CloudStack
operator environment, fetch the public manifest from GitHub Pages or object
storage, verify the signed checksum sets, then register missing versions through
the CloudStack API.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path
from typing import Any

try:
    from cs import CloudStack
except ImportError:  # pragma: no cover - exercised by shell validation.
    sys.exit("Missing dependency: pip install cs")


DEFAULT_MANIFEST_URL = "https://runatlas-is.github.io/cks-images/manifest.json"


def required_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        sys.exit(f"Missing required environment variable: {name}")
    return value


def fetch_bytes(url: str, timeout: int = 30) -> bytes:
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return response.read()


def fetch_json(url: str) -> dict[str, Any]:
    return json.loads(fetch_bytes(url).decode("utf-8"))


def supported_versions(payload: dict[str, Any]) -> list[dict[str, Any]]:
    for key in ("kubernetessupportedversion", "kubernetessupportedversions"):
        value = payload.get(key)
        if isinstance(value, list):
            return value
        if isinstance(value, dict):
            return [value]
    return []


def normalize_checksum(value: str) -> str:
    checksum = value.strip()
    if re.fullmatch(r"\{[^}]+\}[0-9a-fA-F]+", checksum):
        return checksum
    if re.fullmatch(r"[0-9a-fA-F]{64}", checksum):
        return "{SHA-256}" + checksum.lower()
    if re.fullmatch(r"[0-9a-fA-F]{32}", checksum):
        return checksum.lower()
    sys.exit(f"Unsupported checksum format: {checksum}")


def plain_sha256(value: str) -> str:
    checksum = value.strip()
    if checksum.upper().startswith("{SHA-256}"):
        checksum = checksum[len("{SHA-256}") :]
    if not re.fullmatch(r"[0-9a-fA-F]{64}", checksum):
        sys.exit(f"Expected SHA-256 checksum, got: {value}")
    return checksum.lower()


def zone_ids(args: argparse.Namespace) -> list[str]:
    values = list(args.zone_id or [])
    env_values = os.environ.get("CLOUDSTACK_ZONE_IDS") or os.environ.get("CLOUDSTACK_ZONE_ID")
    if env_values:
        values.extend(part.strip() for part in env_values.split(","))
    zones = [value for value in values if value]
    if not zones:
        sys.exit("Provide --zone-id or CLOUDSTACK_ZONE_ID/CLOUDSTACK_ZONE_IDS")
    return list(dict.fromkeys(zones))


def is_eol(image: dict[str, Any], today: dt.date) -> bool:
    lifecycle = image.get("lifecycle")
    if not isinstance(lifecycle, dict):
        return False
    eol = lifecycle.get("eol")
    if not isinstance(eol, str) or not eol:
        return False
    try:
        return dt.date.fromisoformat(eol) < today
    except ValueError:
        return False


def semver_key(value: Any) -> tuple[int, int, int]:
    parts = str(value).split(".")
    if len(parts) != 3:
        return (0, 0, 0)
    try:
        return (int(parts[0]), int(parts[1]), int(parts[2]))
    except ValueError:
        return (0, 0, 0)


def selected_images(manifest: dict[str, Any], args: argparse.Namespace) -> list[dict[str, Any]]:
    wanted_versions = set(args.version or [])
    wanted_minors = set(args.minor or [])
    today = dt.datetime.now(dt.timezone.utc).date()

    out: list[dict[str, Any]] = []
    for image in manifest.get("images", []):
        if not isinstance(image, dict):
            continue
        cloudstack = image.get("cloudstack")
        if not isinstance(cloudstack, dict):
            continue
        if args.arch and cloudstack.get("arch") != args.arch:
            continue
        if wanted_versions and image.get("version") not in wanted_versions:
            continue
        if wanted_minors and image.get("minor") not in wanted_minors:
            continue
        if not args.include_eol and is_eol(image, today):
            continue
        out.append(image)

    if args.latest_per_minor:
        latest: dict[str, dict[str, Any]] = {}
        for image in out:
            minor = str(image.get("minor"))
            current = latest.get(minor)
            if current is None or semver_key(image.get("version")) > semver_key(current.get("version")):
                latest[minor] = image
        out = list(latest.values())

    out.sort(key=lambda item: semver_key(item.get("version")))
    return out


def parse_checksum_file(content: bytes) -> dict[str, str]:
    checksums: dict[str, str] = {}
    for raw_line in content.decode("utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) < 2:
            continue
        digest, filename = parts[0], parts[1]
        if re.fullmatch(r"[0-9a-fA-F]{64}", digest):
            checksums[filename] = digest.lower()
    return checksums


def import_and_check_key(gpg_home: Path, key_path: Path, expected_fingerprint: str) -> None:
    subprocess.run(
        ["gpg", "--batch", "--homedir", str(gpg_home), "--import", str(key_path)],
        check=True,
        stdout=subprocess.DEVNULL,
    )
    result = subprocess.run(
        ["gpg", "--batch", "--homedir", str(gpg_home), "--with-colons", "--fingerprint"],
        check=True,
        capture_output=True,
        text=True,
    )
    fingerprints = {
        line.split(":")[9].upper()
        for line in result.stdout.splitlines()
        if line.startswith("fpr:")
    }
    if expected_fingerprint.upper().replace(" ", "") not in fingerprints:
        sys.exit("Signing key fingerprint does not match the pinned fingerprint")


def verify_signature(gpg_home: Path, signature: Path, payload: Path) -> None:
    subprocess.run(
        ["gpg", "--batch", "--homedir", str(gpg_home), "--verify", str(signature), str(payload)],
        check=True,
        stdout=subprocess.DEVNULL,
    )


def verify_images(manifest: dict[str, Any], images: list[dict[str, Any]], args: argparse.Namespace) -> None:
    if args.skip_gpg_verify:
        return
    if not shutil.which("gpg"):
        sys.exit("gpg is required for checksum verification")

    signing = manifest.get("signingKey") if isinstance(manifest.get("signingKey"), dict) else {}
    key_url = args.key_url or signing.get("url")
    fingerprint = args.signing_fingerprint or signing.get("fingerprint")
    if not key_url or not fingerprint:
        sys.exit("Manifest signing key URL and fingerprint are required")

    cache_root = Path(os.environ.get("CKS_SYNC_TMPDIR", ".cache"))
    cache_root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="cks-sync-", dir=cache_root) as temp_name:
        temp = Path(temp_name)
        gpg_home = temp / "gnupg"
        gpg_home.mkdir(mode=0o700)
        key_path = temp / "signing-key.asc"
        key_path.write_bytes(fetch_bytes(str(key_url)))
        import_and_check_key(gpg_home, key_path, str(fingerprint))

        checksum_cache: dict[tuple[str, str], dict[str, str]] = {}
        for image in images:
            checksum_url = image.get("checksumSetUrl")
            signature_url = image.get("checksumSetSignatureUrl")
            if not checksum_url or not signature_url:
                sys.exit(f"{image.get('filename')} is missing checksum set URLs")
            cache_key = (str(checksum_url), str(signature_url))
            if cache_key not in checksum_cache:
                checksum_path = temp / f"checksum-{len(checksum_cache)}"
                signature_path = temp / f"checksum-{len(checksum_cache)}.asc"
                checksum_path.write_bytes(fetch_bytes(str(checksum_url)))
                signature_path.write_bytes(fetch_bytes(str(signature_url)))
                verify_signature(gpg_home, signature_path, checksum_path)
                checksum_cache[cache_key] = parse_checksum_file(checksum_path.read_bytes())

            filename = str(image.get("filename"))
            expected = plain_sha256(str(image.get("sha256") or ""))
            actual = checksum_cache[cache_key].get(filename)
            if actual != expected:
                sys.exit(f"Signed checksum mismatch for {filename}")


def register_image(
    cs: CloudStack,
    image: dict[str, Any],
    zone_id: str,
    existing: list[dict[str, Any]],
    args: argparse.Namespace,
) -> None:
    cloudstack = image["cloudstack"]
    version = str(cloudstack["semanticVersion"])
    arch = str(cloudstack.get("arch") or args.arch)
    name = str(cloudstack.get("name") or f"v{version}")

    for item in existing:
        same_version = item.get("semanticversion") == version
        same_zone = item.get("zoneid") == zone_id
        same_arch = not item.get("arch") or item.get("arch") == arch
        if not (same_version and same_zone and same_arch):
            continue
        state = str(item.get("state") or "Enabled")
        item_id = item.get("id")
        print(f"[cloudstack] {version} already registered in zone {zone_id} ({item_id}, state={state})")
        if args.enable_existing and item_id and state.lower() == "disabled":
            if args.dry_run:
                print(f"[cloudstack] dry-run: would enable {version} in zone {zone_id}")
            else:
                cs.updateKubernetesSupportedVersion(id=item_id, state="Enabled")
                print(f"[cloudstack] enabled {version} in zone {zone_id}")
        return

    params = {
        "name": name,
        "semanticversion": version,
        "zoneid": zone_id,
        "url": image["url"],
        "checksum": normalize_checksum(str(image["sha256"])),
        "arch": arch,
        "mincpunumber": int(cloudstack.get("minCpuNumber") or args.min_cpu),
        "minmemory": int(cloudstack.get("minMemory") or args.min_memory),
        "directdownload": bool(cloudstack.get("directDownload", args.direct_download)),
    }
    if args.dry_run:
        print(f"[cloudstack] dry-run: would register {version} in zone {zone_id}: {params['url']}")
        return
    result = cs.addKubernetesSupportedVersion(**params)
    created = supported_versions(result)
    created_id = created[0].get("id") if created else "unknown"
    print(f"[cloudstack] registered {version} in zone {zone_id}: {created_id}")


def manifest_version_index(manifest: dict[str, Any], arch: str) -> dict[str, dict[str, Any]]:
    """Map semantic version -> {minor, eol} for every manifest image of the arch.

    The index intentionally covers all manifest images, including EOL ones, so
    state reconciliation can disable registered versions that the selection
    filters no longer return. Versions absent from the manifest are never
    touched: they are not owned by this pipeline.
    """
    index: dict[str, dict[str, Any]] = {}
    for image in manifest.get("images", []):
        if not isinstance(image, dict):
            continue
        cloudstack = image.get("cloudstack")
        if not isinstance(cloudstack, dict) or cloudstack.get("arch") != arch:
            continue
        version = str(cloudstack.get("semanticVersion") or image.get("version") or "")
        if not version:
            continue
        lifecycle = image.get("lifecycle") if isinstance(image.get("lifecycle"), dict) else {}
        index[version] = {"minor": str(image.get("minor")), "eol": lifecycle.get("eol")}
    return index


def parse_cloudstack_time(value: Any) -> dt.datetime | None:
    try:
        return dt.datetime.strptime(str(value), "%Y-%m-%dT%H:%M:%S%z")
    except ValueError:
        return None


def reconcile_states(
    cs: CloudStack,
    zone_id: str,
    index: dict[str, dict[str, Any]],
    args: argparse.Namespace,
) -> list[str]:
    """Disable superseded/EOL registered versions and report stalled ISOs.

    Only versions whose semantic version appears in the manifest are managed.
    Disabling never removes anything: running clusters keep working and can
    still upgrade to a newer enabled version; only new-cluster creation on the
    disabled version is blocked.
    """
    now = dt.datetime.now(dt.timezone.utc)
    today = now.date()
    existing = supported_versions(cs.listKubernetesSupportedVersions(zoneid=zone_id, arch=args.arch))
    managed = [item for item in existing if str(item.get("semanticversion")) in index]

    ready_newest: dict[str, tuple[int, int, int]] = {}
    for item in managed:
        if str(item.get("isostate")) != "Ready":
            continue
        minor = index[str(item.get("semanticversion"))]["minor"]
        key = semver_key(item.get("semanticversion"))
        if minor not in ready_newest or key > ready_newest[minor]:
            ready_newest[minor] = key

    stalled: list[str] = []
    for item in managed:
        version = str(item.get("semanticversion"))
        minor = index[version]["minor"]
        item_id = item.get("id")

        if str(item.get("isostate")) != "Ready":
            created = parse_cloudstack_time(item.get("created"))
            age_hours = (now - created).total_seconds() / 3600 if created else None
            if age_hours is None or age_hours >= args.stalled_after_hours:
                age_text = f"{round(age_hours)}h" if age_hours is not None else "unknown age"
                stalled.append(
                    f"{version} in zone {zone_id} ({item_id}): ISO state "
                    f"{item.get('isostate')} after {age_text}"
                )

        reason = None
        if args.disable_eol:
            eol = index[version].get("eol")
            if isinstance(eol, str) and eol:
                try:
                    if dt.date.fromisoformat(eol) < today:
                        reason = f"Kubernetes {minor} is past EOL ({eol})"
                except ValueError:
                    pass
        if reason is None and args.disable_superseded:
            newest_ready = ready_newest.get(minor)
            if newest_ready and semver_key(version) < newest_ready:
                reason = f"superseded by a Ready {minor} patch"
        if reason is None or str(item.get("state") or "").lower() != "enabled":
            continue
        if args.dry_run:
            print(f"[cloudstack] dry-run: would disable {version} in zone {zone_id}: {reason}")
        else:
            cs.updateKubernetesSupportedVersion(id=item_id, state="Disabled")
            print(f"[cloudstack] disabled {version} in zone {zone_id}: {reason}")
    return stalled


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest-url", default=os.environ.get("CKS_MANIFEST_URL", DEFAULT_MANIFEST_URL))
    parser.add_argument("--zone-id", action="append", help="CloudStack zone ID. May be repeated.")
    parser.add_argument("--version", action="append", help="Only sync this Kubernetes semantic version. May be repeated.")
    parser.add_argument("--minor", action="append", help="Only sync this Kubernetes minor, for example 1.34.")
    parser.add_argument("--arch", default=os.environ.get("CKS_ARCH", "x86_64"), choices=("x86_64", "aarch64"))
    parser.add_argument("--min-cpu", type=int, default=int(os.environ.get("CKS_MIN_CPU", "2")))
    parser.add_argument("--min-memory", type=int, default=int(os.environ.get("CKS_MIN_MEMORY", "2048")))
    parser.add_argument("--direct-download", action="store_true", default=os.environ.get("CKS_DIRECT_DOWNLOAD", "").lower() == "true")
    parser.add_argument("--latest-per-minor", action="store_true", help="Sync only the newest patch for each selected minor.")
    parser.add_argument("--include-eol", action="store_true", help="Include images whose Kubernetes minor is past EOL.")
    parser.add_argument("--enable-existing", action="store_true", help="Enable matching disabled supported versions.")
    parser.add_argument(
        "--disable-superseded",
        action="store_true",
        help="Disable enabled versions of a minor once a newer patch of that minor has a Ready ISO.",
    )
    parser.add_argument(
        "--disable-eol",
        action="store_true",
        help="Disable enabled versions whose Kubernetes minor is past EOL per the manifest lifecycle.",
    )
    parser.add_argument(
        "--fail-on-stalled",
        action="store_true",
        help="Exit non-zero when a registered version's ISO is still not Ready past the stall window.",
    )
    parser.add_argument(
        "--stalled-after-hours",
        type=float,
        default=float(os.environ.get("CKS_STALLED_AFTER_HOURS", "12")),
        help="Age in hours before a non-Ready ISO counts as stalled.",
    )
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--key-url", help="Override manifest signing key URL.")
    parser.add_argument("--signing-fingerprint", default=os.environ.get("GPG_SIGNING_FINGERPRINT"))
    parser.add_argument("--skip-gpg-verify", action="store_true", help="Skip signed checksum verification.")
    args = parser.parse_args()

    endpoint = required_env("CLOUDSTACK_ENDPOINT")
    api_key = required_env("CLOUDSTACK_API_KEY")
    secret_key = required_env("CLOUDSTACK_SECRET_KEY")
    zones = zone_ids(args)

    manifest = fetch_json(args.manifest_url)
    images = selected_images(manifest, args)
    reconcile = args.disable_superseded or args.disable_eol or args.fail_on_stalled
    if not images:
        print("[cloudstack] no manifest images matched the selected filters")
        if not reconcile:
            return

    if images:
        verify_images(manifest, images, args)

    cs = CloudStack(endpoint=endpoint, key=api_key, secret=secret_key, timeout=120)
    index = manifest_version_index(manifest, args.arch)
    stalled: list[str] = []
    for zone_id in zones:
        existing = supported_versions(cs.listKubernetesSupportedVersions(zoneid=zone_id, arch=args.arch))
        for image in images:
            register_image(cs, image, zone_id, existing, args)
        if reconcile:
            stalled.extend(reconcile_states(cs, zone_id, index, args))

    for line in stalled:
        print(f"[cloudstack] stalled: {line}", file=sys.stderr)
    if stalled and args.fail_on_stalled:
        sys.exit(1)


if __name__ == "__main__":
    main()
