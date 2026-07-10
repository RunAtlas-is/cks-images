#!/usr/bin/env bash
# Sign CKS ISO objects under the artifact prefix with the artifact key
# (ed25519, fingerprint 4C2D72FDDEF77A5CC4A7D2C421CA4588DCB6991E), and publish
# one CHECKSUM-<minor> file per Kubernetes minor version (1.33, 1.34, ...)
# with a detached .asc signature so the per-minor sets can scale without a
# single unbounded CHECKSUM.
#
# Provenance gate: the bucket prefix is shared and writable by more identities
# than this pipeline, so presence in the bucket is not proof an object came
# from our build. An ISO is only signed and only listed in a CHECKSUM set when
# its digest is established by one of:
#   1. the current run's build manifest (BUILT_DIGESTS_FILE, "sha256  filename"
#      lines emitted by the build job for ISOs it built and uploaded),
#   2. an entry in the already-published CHECKSUM-<minor> whose detached
#      signature verifies against SIGNING_FINGERPRINT,
#   3. for an ISO that already has a .asc sibling but no digest record, the
#      downloaded ISO verifying against that signature with the pinned key.
# Anything else is an unexpected object: it is skipped, reported loudly, and
# fails the run (exit 3) after the trusted work completes. A trusted ISO whose
# bucket content or .sha256 sibling contradicts the trusted digest fails the
# run immediately (exit 2).
#
# Idempotent: skips ISOs whose .asc sibling already exists; always regenerates
# CHECKSUM-<minor> / CHECKSUM-<minor>.asc for every minor present in the
# bucket.
#
# Required env: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_ENDPOINT_URL,
# BUCKET_NAME.
# Optional env:
#   S3_PREFIX            key prefix inside bucket (default: cks/)
#   SIGNING_KEY          fingerprint or uid of the key to use
#                        (default: artifacts@runatlas.is)
#   SIGNING_FINGERPRINT  pinned fingerprint used to verify existing signatures
#                        (default: the Atlas artifact key fingerprint above)
#   BUILT_DIGESTS_FILE   manifest of ISOs built by the current run
#   GNUPGHOME            keyring location (default: $HOME/.gnupg-atlas)
#   GPG_PASSPHRASE       optional passphrase for SIGNING_KEY in CI

set -euo pipefail

: "${AWS_ACCESS_KEY_ID:?}"
: "${AWS_SECRET_ACCESS_KEY:?}"
: "${AWS_ENDPOINT_URL:?}"
: "${BUCKET_NAME:?}"

SIGNING_KEY="${SIGNING_KEY:-artifacts@runatlas.is}"
SIGNING_FINGERPRINT="${SIGNING_FINGERPRINT:-4C2D72FDDEF77A5CC4A7D2C421CA4588DCB6991E}"
SIGNING_FINGERPRINT="${SIGNING_FINGERPRINT//[[:space:]]/}"
SIGNING_FINGERPRINT="${SIGNING_FINGERPRINT^^}"
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
gpg_sign_args=(--batch --yes --local-user "$SIGNING_KEY")

# Detach-sign $1 into $2. The passphrase travels on fd 0, never on the
# command line, so it cannot show up in the process listing.
gpg_detach_sign() {
  if [[ -n "${GPG_PASSPHRASE:-}" ]]; then
    gpg "${gpg_sign_args[@]}" --pinentry-mode loopback --passphrase-fd 0 \
        --armor --detach-sign --output "$2" "$1" <<<"$GPG_PASSPHRASE"
  else
    gpg "${gpg_sign_args[@]}" --armor --detach-sign --output "$2" "$1"
  fi
}

# Verify detached signature $1 over payload $2 and require the pinned
# fingerprint, so a valid signature from any other imported key is rejected.
# VALIDSIG carries the signing (sub)key fingerprint first and the primary key
# fingerprint last, so accept the pin in either position.
gpg_verify_pinned() {
  local status
  status=$(gpg --batch --status-fd 1 --verify "$1" "$2" 2>/dev/null) || return 1
  grep "^\[GNUPG:\] VALIDSIG " <<<"$status" | grep -q "$SIGNING_FINGERPRINT"
}

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

# --- Provenance: collect trusted digests ------------------------------------

declare -A trusted   # iso filename -> sha256 established by a trusted source

# Source 1: the current run's build manifest.
if [[ -n "${BUILT_DIGESTS_FILE:-}" && -s "${BUILT_DIGESTS_FILE}" ]]; then
  while read -r digest name; do
    [[ "$digest" =~ ^[0-9a-fA-F]{64}$ && -n "$name" ]] || continue
    trusted["$name"]="${digest,,}"
    echo "[provenance] built this run: ${name}"
  done < "$BUILT_DIGESTS_FILE"
fi

# Source 2: previously published CHECKSUM-<minor> sets, verified against the
# pinned key. Their entries were attested by an earlier run of this pipeline.
for minor in "${!minor_isos[@]}"; do
  checksum="CHECKSUM-${minor}"
  grep -Fxq "$checksum" "$tmp/keys" || continue
  grep -Fxq "${checksum}.asc" "$tmp/keys" || continue
  aws "${aws_opts[@]}" s3 cp "s3://${BUCKET_NAME}/${S3_PREFIX}${checksum}" "$tmp/prev-${checksum}" --only-show-errors
  aws "${aws_opts[@]}" s3 cp "s3://${BUCKET_NAME}/${S3_PREFIX}${checksum}.asc" "$tmp/prev-${checksum}.asc" --only-show-errors
  if ! gpg_verify_pinned "$tmp/prev-${checksum}.asc" "$tmp/prev-${checksum}"; then
    echo "!! signature on existing ${checksum} does not verify against ${SIGNING_FINGERPRINT}" >&2
    exit 2
  fi
  while read -r digest name; do
    [[ "$digest" =~ ^[0-9a-f]{64}$ && -n "$name" ]] || continue
    [[ -n "${trusted[$name]:-}" ]] || trusted["$name"]="$digest"
  done < <(grep -E '^[0-9a-f]{64}' "$tmp/prev-${checksum}")
done

unexpected=()

# --- Sign individual ISOs ----------------------------------------------------

for iso in "${isos[@]}"; do
  asc="${iso}.asc"
  has_asc=false
  grep -Fxq "$asc" "$tmp/keys" && has_asc=true

  if [[ -z "${trusted[$iso]:-}" && "$has_asc" == true ]]; then
    # Source 3: signed by an earlier run but missing from every CHECKSUM set
    # (e.g. a run that died between signing and checksum publication).
    # The existing signature itself is the provenance record; verify it.
    aws "${aws_opts[@]}" s3 cp "s3://${BUCKET_NAME}/${S3_PREFIX}${iso}" "$tmp/download/${iso}" --only-show-errors
    aws "${aws_opts[@]}" s3 cp "s3://${BUCKET_NAME}/${S3_PREFIX}${asc}" "$tmp/download/${asc}" --only-show-errors
    if gpg_verify_pinned "$tmp/download/${asc}" "$tmp/download/${iso}"; then
      trusted["$iso"]=$(sha256sum "$tmp/download/${iso}" | awk '{print $1}')
      echo "[provenance] recovered from existing signature: ${iso}"
    else
      echo "!! ${iso} carries a .asc that does not verify against ${SIGNING_FINGERPRINT}" >&2
      unexpected+=("$iso")
    fi
    rm -f "$tmp/download/${iso}" "$tmp/download/${asc}"
    continue
  fi

  if [[ -z "${trusted[$iso]:-}" ]]; then
    echo "!! ${iso} has no provenance (not built this run, absent from every signed CHECKSUM set); refusing to sign" >&2
    unexpected+=("$iso")
    continue
  fi

  if [[ "$has_asc" == true ]]; then
    echo "[skip-sign] ${iso} already has ${asc}"
    continue
  fi

  echo "[sign] ${iso}"
  aws "${aws_opts[@]}" s3 cp "s3://${BUCKET_NAME}/${S3_PREFIX}${iso}" "$tmp/download/${iso}" --only-show-errors
  actual=$(sha256sum "$tmp/download/${iso}" | awk '{print $1}')
  if [[ "$actual" != "${trusted[$iso]}" ]]; then
    echo "!! ${iso} in the bucket does not match its trusted digest (expected ${trusted[$iso]}, got ${actual}); refusing to sign" >&2
    exit 2
  fi
  gpg_detach_sign "$tmp/download/${iso}" "$tmp/download/${asc}"
  aws "${aws_opts[@]}" s3 cp "$tmp/download/${asc}" "s3://${BUCKET_NAME}/${S3_PREFIX}${asc}" \
      --content-type "application/pgp-signature" --only-show-errors
  rm -f "$tmp/download/${iso}" "$tmp/download/${asc}"
done

# --- Regenerate per-minor CHECKSUM files from trusted digests -----------------

for minor in "${!minor_isos[@]}"; do
  checksum="CHECKSUM-${minor}"
  {
    printf '# CKS binary ISOs - Kubernetes %s - %s\n' "$minor" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '# Verify:\n'
    printf '#   gpg --verify %s.asc %s\n' "$checksum" "$checksum"
    printf '#   sha256sum --check --ignore-missing %s\n' "$checksum"
    while IFS= read -r iso; do
      [[ -z "$iso" ]] && continue
      [[ -n "${trusted[$iso]:-}" ]] || continue
      # Cross-check the public .sha256 sibling against the trusted digest so a
      # tampered or missing sidecar is loud instead of silently republished.
      sha_key="${iso}.sha256"
      if ! grep -Fxq "$sha_key" "$tmp/keys"; then
        echo "!! ${sha_key} is missing for trusted ISO ${iso}; refusing to publish ${checksum}" >&2
        exit 2
      fi
      if ! published=$(aws "${aws_opts[@]}" s3 cp "s3://${BUCKET_NAME}/${S3_PREFIX}${sha_key}" - | awk '{print $1}'); then
        echo "!! digest fetch failed for ${sha_key}; refusing to publish partial ${checksum}" >&2
        exit 2
      fi
      if [[ "${published,,}" != "${trusted[$iso]}" ]]; then
        echo "!! ${sha_key} (${published}) does not match the trusted digest for ${iso} (${trusted[$iso]}); refusing to publish ${checksum}" >&2
        exit 2
      fi
      printf '%s  %s\n' "${trusted[$iso]}" "$iso"
    done <<< "${minor_isos[$minor]}"
  } > "$tmp/${checksum}"

  gpg_detach_sign "$tmp/${checksum}" "$tmp/${checksum}.asc"

  aws "${aws_opts[@]}" s3 cp "$tmp/${checksum}" "s3://${BUCKET_NAME}/${S3_PREFIX}${checksum}" \
      --content-type "text/plain; charset=utf-8" --only-show-errors
  aws "${aws_opts[@]}" s3 cp "$tmp/${checksum}.asc" "s3://${BUCKET_NAME}/${S3_PREFIX}${checksum}.asc" \
      --content-type "application/pgp-signature" --only-show-errors
  entries=$(grep -cE '^[0-9a-f]{64}' "$tmp/${checksum}" || true)
  echo "[sign] ${checksum}: ${entries} entries"
done

if [[ ${#unexpected[@]} -gt 0 ]]; then
  {
    echo "!! ${#unexpected[@]} unexpected ISO object(s) in s3://${BUCKET_NAME}/${S3_PREFIX} were skipped:"
    printf '!!   %s\n' "${unexpected[@]}"
    echo "!! These objects were not produced by this pipeline. Investigate how they were written;"
    echo "!! remove them from the bucket or, if legitimate, re-publish them through the build job."
  } >&2
  exit 3
fi
