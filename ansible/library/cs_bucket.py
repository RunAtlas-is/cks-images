#!/usr/bin/python
# -*- coding: utf-8 -*-

# Minimal idempotent module for CloudStack object-storage buckets.
# The ngine_io.cloudstack collection does not (yet) expose the 4.19+
# bucket API, so we call `cmk` directly. Designed to be `--check` safe.

from __future__ import annotations

import json
import subprocess
from typing import Any

from ansible.module_utils.basic import AnsibleModule


def cmk_json(profile: str, *args: str) -> Any:
    proc = subprocess.run(
        ["cmk", "-p", profile, "-o", "json", *args],
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"cmk failed ({proc.returncode}): {proc.stderr or proc.stdout}")
    raw = proc.stdout.lstrip()
    # cmk prints a banner on the first stdout line in interactive mode; ignore if present.
    if not raw.startswith("{") and not raw.startswith("["):
        raw = raw.split("\n", 1)[1] if "\n" in raw else raw
    return json.loads(raw) if raw else {}


def find_bucket(profile: str, name: str) -> dict | None:
    data = cmk_json(profile, "listBuckets", f"name={name}")
    for b in data.get("bucket") or []:
        if b.get("name") == name:
            return b
    return None


def find_objectstore(profile: str, name: str) -> dict | None:
    data = cmk_json(profile, "listObjectStoragePools")
    for s in data.get("objectstore") or []:
        if s.get("name") == name:
            return s
    return None


def main() -> None:
    module = AnsibleModule(
        argument_spec=dict(
            profile=dict(type="str", required=True),
            name=dict(type="str", required=True),
            object_store=dict(type="str", required=True),
            quota=dict(type="int", default=50),
            state=dict(type="str", default="present", choices=["present", "absent"]),
        ),
        supports_check_mode=True,
    )

    profile = module.params["profile"]
    name = module.params["name"]
    store_name = module.params["object_store"]
    quota = module.params["quota"]
    state = module.params["state"]

    try:
        existing = find_bucket(profile, name)
    except RuntimeError as exc:
        module.fail_json(msg=str(exc))

    changed = False
    bucket: dict[str, Any] | None = existing

    if state == "present":
        if existing is None:
            store = find_objectstore(profile, store_name)
            if store is None:
                module.fail_json(msg=f"object store {store_name!r} not found")
            changed = True
            if not module.check_mode:
                created = cmk_json(
                    profile,
                    "createBucket",
                    f"name={name}",
                    f"objectstorageid={store['id']}",
                    f"quota={quota}",
                )
                bucket = created.get("bucket", bucket)
        else:
            if existing.get("quota") != quota:
                changed = True
                if not module.check_mode:
                    updated = cmk_json(
                        profile,
                        "updateBucket",
                        f"id={existing['id']}",
                        f"quota={quota}",
                    )
                    bucket = updated.get("bucket", existing)
    else:
        if existing is not None:
            changed = True
            if not module.check_mode:
                cmk_json(profile, "deleteBucket", f"id={existing['id']}")
            bucket = None

    safe_bucket: dict[str, Any] = {}
    if bucket:
        safe_bucket = {
            "id": bucket.get("id"),
            "name": bucket.get("name"),
            "objectstore": bucket.get("objectstore"),
            "quota": bucket.get("quota"),
            "state": bucket.get("state"),
        }

    module.exit_json(changed=changed, bucket=safe_bucket)


if __name__ == "__main__":
    main()
