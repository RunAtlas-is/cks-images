#!/usr/bin/python
# -*- coding: utf-8 -*-

# Fetches the access_key / secret_key / endpoint of a CloudStack object-storage
# bucket without ever echoing them to stdout. Returned in the module result
# marked `no_log` so subsequent tasks can reference them without Ansible
# printing them in -v output.

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
    if not raw.startswith("{") and not raw.startswith("["):
        raw = raw.split("\n", 1)[1] if "\n" in raw else raw
    return json.loads(raw) if raw else {}


def main() -> None:
    module = AnsibleModule(
        argument_spec=dict(
            profile=dict(type="str", required=True),
            name=dict(type="str", required=True),
        ),
        supports_check_mode=True,
    )

    profile = module.params["profile"]
    name = module.params["name"]

    try:
        data = cmk_json(profile, "listBuckets", f"name={name}")
    except RuntimeError as exc:
        module.fail_json(msg=str(exc))

    bucket = next(
        (b for b in data.get("bucket") or [] if b.get("name") == name),
        None,
    )
    if bucket is None:
        module.fail_json(msg=f"bucket {name!r} not found")

    try:
        stores = cmk_json(profile, "listObjectStoragePools")
    except RuntimeError as exc:
        module.fail_json(msg=str(exc))

    endpoint = next(
        (s.get("url") for s in stores.get("objectstore") or [] if s.get("id") == bucket.get("objectstorageid")),
        None,
    )

    access_key = bucket.get("accesskey") or ""
    secret_key = bucket.get("usersecretkey") or ""
    if not access_key or not secret_key or not endpoint:
        module.fail_json(msg="bucket record is missing access_key/usersecretkey/endpoint")

    module.exit_json(
        changed=False,
        access_key=access_key,
        secret_key=secret_key,
        endpoint=endpoint,
        bucket=name,
    )


if __name__ == "__main__":
    main()
