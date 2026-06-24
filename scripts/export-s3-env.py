#!/usr/bin/env python3
"""Export Atlas object-storage credentials from CloudStack bucket metadata.

GitHub Actions should not carry long-lived S3 credentials when the CloudStack
API account can discover the bucket credentials at runtime. This script looks
up the configured bucket and writes AWS-compatible environment variables to
the GitHub Actions env file.
"""

from __future__ import annotations

import argparse
import os
import sys
from urllib.parse import urlsplit, urlunsplit
from typing import Any

try:
    from cs import CloudStack
except ImportError:  # pragma: no cover - exercised in CI shell, not unit tests.
    sys.exit("Missing dependency: pip install cs")


DEFAULT_ENDPOINT = "https://sky.runatlas.is/client/api"
DEFAULT_S3_ENDPOINT = "https://s3.runatlas.is"


def required_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        sys.exit(f"Missing required environment variable: {name}")
    return value


def first_list(payload: dict[str, Any], *keys: str) -> list[dict[str, Any]]:
    for key in keys:
        value = payload.get(key)
        if isinstance(value, list):
            return [item for item in value if isinstance(item, dict)]
        if isinstance(value, dict):
            return [value]
    return []


def pick(item: dict[str, Any], *keys: str) -> str | None:
    lowered = {key.lower(): value for key, value in item.items()}
    for key in keys:
        value = lowered.get(key.lower())
        if value is not None and str(value):
            return str(value)
    return None


def write_env(path: str, values: dict[str, str]) -> None:
    with open(path, "a", encoding="utf-8") as env_file:
        for key, value in values.items():
            env_file.write(f"{key}={value}\n")


def mask(value: str | None) -> None:
    if value and os.environ.get("GITHUB_ACTIONS"):
        print(f"::add-mask::{value}")


def object_storage_endpoint(cs: CloudStack, bucket: dict[str, Any], fallback: str) -> str:
    endpoint = pick(bucket, "endpoint", "url", "objectstorageurl", "objectstoragepoolurl")
    if endpoint:
        return endpoint

    object_storage_id = pick(bucket, "objectstorageid", "objectstoragepoolid", "poolid")
    try:
        pools = first_list(
            cs.listObjectStoragePools(listall=True),
            "objectstoragepool",
            "objectstoragepools",
        )
    except Exception as exc:  # noqa: BLE001 - surface a fallback notice, do not break upload.
        print(f"[s3-env] listObjectStoragePools failed; using fallback endpoint: {exc}", file=sys.stderr)
        return fallback

    if object_storage_id:
        for pool in pools:
            if pick(pool, "id") == object_storage_id:
                return pick(pool, "endpoint", "url", "hostname") or fallback

    if len(pools) == 1:
        return pick(pools[0], "endpoint", "url", "hostname") or fallback

    return fallback


def normalize_s3_endpoint(endpoint: str, bucket_name: str) -> str:
    """Return the service endpoint AWS clients expect, not the bucket URL."""

    parts = urlsplit(endpoint)
    if not parts.scheme or not parts.netloc:
        return endpoint.rstrip("/")

    bucket_path = "/" + bucket_name.strip("/")
    if parts.path.rstrip("/") == bucket_path:
        return urlunsplit((parts.scheme, parts.netloc, "", "", ""))

    return endpoint.rstrip("/")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bucket", default=os.environ.get("BUCKET_NAME", "atlas-static-assets"))
    parser.add_argument("--env-file", default=os.environ.get("GITHUB_ENV"))
    parser.add_argument(
        "--fallback-endpoint",
        default=os.environ.get("AWS_ENDPOINT_URL", DEFAULT_S3_ENDPOINT),
        help="S3 endpoint to use if CloudStack does not return the pool URL.",
    )
    args = parser.parse_args()

    if not args.env_file:
        sys.exit("Missing --env-file or GITHUB_ENV")

    endpoint = os.environ.get("CLOUDSTACK_ENDPOINT", DEFAULT_ENDPOINT)
    api_key = required_env("CLOUDSTACK_API_KEY")
    secret_key = required_env("CLOUDSTACK_SECRET_KEY")

    cs = CloudStack(endpoint=endpoint, key=api_key, secret=secret_key, timeout=120)
    response = cs.listBuckets(name=args.bucket, listall=True)
    buckets = first_list(response, "bucket", "buckets")
    bucket = next((item for item in buckets if pick(item, "name") == args.bucket), None)
    if not bucket:
        names = ", ".join(sorted(filter(None, (pick(item, "name") for item in buckets))))
        suffix = f" Found: {names}" if names else ""
        sys.exit(f"Bucket not found through CloudStack: {args.bucket}.{suffix}")

    access_key = pick(bucket, "accesskey", "access_key", "awsaccesskey")
    secret_access_key = pick(bucket, "usersecretkey", "secretkey", "secret_access_key", "awssecretkey")
    if not access_key or not secret_access_key:
        available = ", ".join(sorted(bucket.keys()))
        sys.exit(f"Bucket metadata did not include S3 credentials. Available fields: {available}")

    s3_endpoint = normalize_s3_endpoint(
        object_storage_endpoint(cs, bucket, args.fallback_endpoint),
        args.bucket,
    )
    values = {
        "AWS_ACCESS_KEY_ID": access_key,
        "AWS_SECRET_ACCESS_KEY": secret_access_key,
        "AWS_ENDPOINT_URL": s3_endpoint,
        "S3_ENDPOINT_URL": s3_endpoint,
        "BUCKET_NAME": args.bucket,
        "S3_BUCKET": args.bucket,
    }

    mask(access_key)
    mask(secret_access_key)
    write_env(args.env_file, values)
    print(f"[s3-env] exported S3 env for bucket {args.bucket} via {s3_endpoint}")


if __name__ == "__main__":
    main()
