#!/usr/bin/env bash
# Build a CloudStack Kubernetes Service (CKS) binaries ISO and optionally
# upload it to an S3-compatible bucket.
#
# Wraps upstream create-kubernetes-binaries-iso.sh from apache/cloudstack.
# Fetches the upstream script at the commit pinned in UPSTREAM_REF so builds
# are reproducible; bump the pin after reviewing the upstream diff.
#
# Required env:
#   K8S_VERSION           e.g. 1.33.1 (no leading v)
#   CNI_VERSION           e.g. 1.6.2
#   CRICTL_VERSION        e.g. 1.33.0
#   CNI_YAML_URL          e.g. Calico manifest URL
#   HEADLAMP_VERSION      e.g. 0.25.0
#
# Optional env:
#   ARCH                  amd64 (default) | arm64
#   ETCD_VERSION          e.g. 3.5.15 (optional; 4.21+)
#   OUTPUT_DIR            defaults to ./output
#   S3_BUCKET             upload target; skip upload if unset
#   S3_ENDPOINT_URL       e.g. https://s3.runatlas.is
#   S3_PREFIX             key prefix inside bucket (default: cks/)
#   GPG_PASSPHRASE        optional passphrase for SIGNING_KEY in CI

set -euo pipefail

: "${K8S_VERSION:?K8S_VERSION is required}"
: "${CNI_VERSION:?CNI_VERSION is required}"
: "${CRICTL_VERSION:?CRICTL_VERSION is required}"
: "${CNI_YAML_URL:?CNI_YAML_URL is required}"
: "${HEADLAMP_VERSION:?HEADLAMP_VERSION is required}"

ARCH="${ARCH:-amd64}"
OUTPUT_DIR="${OUTPUT_DIR:-./output}"
S3_PREFIX="${S3_PREFIX:-cks/}"
# Pin to a specific apache/cloudstack commit so the build is reproducible
# and a breaking change upstream (positional-arg re-order, etc.) can't
# land silently. Bump this SHA after reviewing the upstream diff.
UPSTREAM_REF="${UPSTREAM_REF:-18075ae4a96be1b545c8d8a5a73004911c6079e7}"
UPSTREAM_URL="https://raw.githubusercontent.com/apache/cloudstack/${UPSTREAM_REF}/scripts/util/create-kubernetes-binaries-iso.sh"
BUILD_NAME="setup-v${K8S_VERSION}-calico-${ARCH}"

mkdir -p "$OUTPUT_DIR"
workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

echo ">> Fetching upstream build script"
curl -fsSL "$UPSTREAM_URL" -o "$workdir/create-kubernetes-binaries-iso.sh"
chmod +x "$workdir/create-kubernetes-binaries-iso.sh"

echo ">> Building ISO for k8s=$K8S_VERSION arch=$ARCH"
"$workdir/create-kubernetes-binaries-iso.sh" \
  "$OUTPUT_DIR" \
  "$K8S_VERSION" \
  "$CNI_VERSION" \
  "$CRICTL_VERSION" \
  "$CNI_YAML_URL" \
  "$HEADLAMP_VERSION" \
  "$BUILD_NAME" \
  "$ARCH" \
  ${ETCD_VERSION:+"$ETCD_VERSION"}

# Upstream may append a machine-arch suffix to the filename (e.g. -x86_64 for amd64).
# Discover the produced ISO rather than assuming the exact name.
iso_path=$(find "$OUTPUT_DIR" -maxdepth 1 -name "${BUILD_NAME}*.iso" -print -quit)
if [[ -z "$iso_path" || ! -f "$iso_path" ]]; then
  echo "!! No ISO matching ${BUILD_NAME}*.iso produced in $OUTPUT_DIR" >&2
  ls -la "$OUTPUT_DIR" >&2 || true
  exit 1
fi
iso_name="$(basename "$iso_path")"

echo ">> Built $iso_path ($(du -h "$iso_path" | cut -f1))"
sha256sum "$iso_path" > "${iso_path}.sha256"

# GPG-sign the ISO if a signing keyring is available. Requires either a
# pre-imported key in GNUPGHOME or the default gnupg directory.
if [[ -n "${SIGNING_KEY:-}" ]] && gpg --batch --list-secret-keys "$SIGNING_KEY" >/dev/null 2>&1; then
  gpg_args=(--batch --yes --local-user "$SIGNING_KEY")
  if [[ -n "${GPG_PASSPHRASE:-}" ]]; then
    # Feed the passphrase on fd 0 so it never appears in the process listing.
    gpg "${gpg_args[@]}" --pinentry-mode loopback --passphrase-fd 0 \
      --armor --detach-sign \
      --output "${iso_path}.asc" \
      "$iso_path" <<<"$GPG_PASSPHRASE"
  else
    gpg "${gpg_args[@]}" \
      --armor --detach-sign \
      --output "${iso_path}.asc" \
      "$iso_path"
  fi
  echo ">> Signed $iso_path -> ${iso_path}.asc"
fi

if [[ -n "${S3_BUCKET:-}" ]]; then
  echo ">> Uploading to s3://${S3_BUCKET}/${S3_PREFIX}"
  aws_opts=()
  [[ -n "${S3_ENDPOINT_URL:-}" ]] && aws_opts+=(--endpoint-url "$S3_ENDPOINT_URL")
  aws "${aws_opts[@]}" s3 cp "$iso_path"         "s3://${S3_BUCKET}/${S3_PREFIX}${iso_name}"
  aws "${aws_opts[@]}" s3 cp "${iso_path}.sha256" "s3://${S3_BUCKET}/${S3_PREFIX}${iso_name}.sha256"
  if [[ -f "${iso_path}.asc" ]]; then
    aws "${aws_opts[@]}" s3 cp "${iso_path}.asc" "s3://${S3_BUCKET}/${S3_PREFIX}${iso_name}.asc" \
      --content-type "application/pgp-signature"
  fi
  echo ">> Uploaded"
else
  echo ">> S3_BUCKET unset; skipping upload"
fi
