#!/usr/bin/env bash
# Sign every ISO object under the CKS artifact prefix with the artifact key
# (ed25519, fingerprint 4C2D72FDDEF77A5CC4A7D2C421CA4588DCB6991E), and publish
# one CHECKSUM-<minor> file per Kubernetes minor version (1.33, 1.34, ...)
# with a detached .asc signature so the per-minor sets can scale without a
# single unbounded CHECKSUM.
#
# Idempotent: skips ISOs whose .asc sibling already exists; always regenerates
# CHECKSUM-<minor> / CHECKSUM-<minor>.asc for every minor present in the
# bucket.
#
# Required env: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_ENDPOINT_URL,
# BUCKET_NAME.
# Optional env:
#   S3_PREFIX         key prefix inside bucket (default: cks/)
#   SIGNING_KEY       fingerprint or uid of the key to use
#                     (default: artifacts@runatlas.is)
#   GNUPGHOME         keyring location (default: $HOME/.gnupg-atlas)
#   GPG_PASSPHRASE    optional passphrase for SIGNING_KEY in CI

set -euo pipefail

: "${AWS_ACCESS_KEY_ID:?}"
: "${AWS_SECRET_ACCESS_KEY:?}"
: "${AWS_ENDPOINT_URL:?}"
: "${BUCKET_NAME:?}"

SIGNING_KEY="${SIGNING_KEY:-artifacts@runatlas.is}"
S3_PREFIX="${S3_PREFIX:-cks/}"
S3_PREFIX="${S3_PREFIX#/}"
[[ -z "$S3_PREFIX" || "$S3_PREFIX" == */ ]] || S3_PREFIX="${S3_PREFIX}/"
export GNUPGHOME="${GNUPGHOME:-$HOME/.gnupg-atlas}"

# Serialise checksum/signature publication. If the lock can't be acquired in
# 5 minutes, bail loudly.
LOCK_DIR="${SIGN_LOCK_DIR:-${RUNNER_TEMP:-.cache}}"
mkdir -p "$LOCK_DIR"
LOCK_FILE="${SIGN_LOCK_FILE:-${LOCK_DIR%/}/cks-publish.lock}"
if [[ -z "${SIGN_FLOCK_ACQUIRED:-}" ]]; then
  exec env SIGN_FLOCK_ACQUIRED=1 flock -w 300 "$LOCK_FILE" "$0" "$@"
fi

aws_opts=(--endpoint-url "$AWS_ENDPOINT_URL")
gpg_args=(--batch --yes --local-user "$SIGNING_KEY")
if [[ -n "${GPG_PASSPHRASE:-}" ]]; then
  gpg_args+=(--pinentry-mode loopback --passphrase "$GPG_PASSPHRASE")
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# Pull the key list as JSON and extract via jq so a key containing spaces,
# tabs, or other oddities can't break the downstream grep / mapfile.
aws "${aws_opts[@]}" s3api list-objects-v2 \
    --bucket "$BUCKET_NAME" --prefix "$S3_PREFIX" \
    --output json \
  | jq -r --arg prefix "$S3_PREFIX" '.Contents[]?.Key | select(startswith($prefix)) | .[($prefix | length):]' > "$tmp/keys"

mapfile -t isos < <(grep -E '\.iso$' "$tmp/keys" || true)
if [[ ${#isos[@]} -eq 0 ]]; then
  echo "[sign] no ISOs found in s3://${BUCKET_NAME}/${S3_PREFIX}"
  exit 0
fi

mkdir -p "$tmp/download"

minor_of() {
  # setup-v1.33.10-calico-amd64-x86_64.iso -> 1.33
  [[ "$1" =~ ^setup-v([0-9]+)\.([0-9]+)\.[0-9]+- ]] && echo "${BASH_REMATCH[1]}.${BASH_REMATCH[2]}"
}

declare -A minor_isos
for iso in "${isos[@]}"; do
  minor=$(minor_of "$iso") || true
  [[ -z "$minor" ]] && continue
  minor_isos["$minor"]+="$iso"$'\n'
done

# Sign individual ISOs
for iso in "${isos[@]}"; do
  asc="${iso}.asc"
  if grep -Fxq "$asc" "$tmp/keys"; then
    echo "[skip-sign] ${iso} already has ${asc}"
    continue
  fi
  echo "[sign] ${iso}"
  aws "${aws_opts[@]}" s3 cp "s3://${BUCKET_NAME}/${S3_PREFIX}${iso}" "$tmp/download/${iso}" --only-show-errors
  gpg "${gpg_args[@]}" \
      --armor --detach-sign \
      --output "$tmp/download/${asc}" \
      "$tmp/download/${iso}"
  aws "${aws_opts[@]}" s3 cp "$tmp/download/${asc}" "s3://${BUCKET_NAME}/${S3_PREFIX}${asc}" \
      --content-type "application/pgp-signature" --only-show-errors
  rm -f "$tmp/download/${iso}" "$tmp/download/${asc}"
done

# Regenerate per-minor CHECKSUM files
for minor in "${!minor_isos[@]}"; do
  checksum="CHECKSUM-${minor}"
  {
    printf '# CKS binary ISOs - Kubernetes %s - %s\n' "$minor" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '# Verify:\n'
    printf '#   gpg --verify %s.asc %s\n' "$checksum" "$checksum"
    printf '#   sha256sum --check --ignore-missing %s\n' "$checksum"
    while IFS= read -r iso; do
      [[ -z "$iso" ]] && continue
      sha_key="${iso}.sha256"
      grep -Fxq "$sha_key" "$tmp/keys" || continue
      # Keep stderr live so an S3 failure (auth, network, missing object) is
      # loud instead of producing an empty digest that gets silently dropped
      # from the signed CHECKSUM file. Abort the whole run if any digest
      # fetch fails. A partial CHECKSUM is worse than no CHECKSUM.
      if ! digest=$(aws "${aws_opts[@]}" s3 cp "s3://${BUCKET_NAME}/${S3_PREFIX}${sha_key}" - | awk '{print $1}'); then
        echo "!! digest fetch failed for ${sha_key}; refusing to publish partial ${checksum}" >&2
        exit 2
      fi
      if [[ -z "$digest" ]]; then
        echo "!! digest fetch produced empty output for ${sha_key}; refusing to publish partial ${checksum}" >&2
        exit 2
      fi
      printf '%s  %s\n' "$digest" "$iso"
    done <<< "${minor_isos[$minor]}"
  } > "$tmp/${checksum}"

  gpg "${gpg_args[@]}" \
      --armor --detach-sign \
      --output "$tmp/${checksum}.asc" \
      "$tmp/${checksum}"

  aws "${aws_opts[@]}" s3 cp "$tmp/${checksum}" "s3://${BUCKET_NAME}/${S3_PREFIX}${checksum}" \
      --content-type "text/plain; charset=utf-8" --only-show-errors
  aws "${aws_opts[@]}" s3 cp "$tmp/${checksum}.asc" "s3://${BUCKET_NAME}/${S3_PREFIX}${checksum}.asc" \
      --content-type "application/pgp-signature" --only-show-errors
  entries=$(grep -cE '^[0-9a-f]{64}' "$tmp/${checksum}" || true)
  echo "[sign] ${checksum}: ${entries} entries"
done
