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
    if not images:
        print("[cloudstack] no manifest images matched the selected filters")
        return

    verify_images(manifest, images, args)

    cs = CloudStack(endpoint=endpoint, key=api_key, secret=secret_key, timeout=120)
    for zone_id in zones:
        existing = supported_versions(cs.listKubernetesSupportedVersions(zoneid=zone_id, arch=args.arch))
        for image in images:
            register_image(cs, image, zone_id, existing, args)


if __name__ == "__main__":
    main()
