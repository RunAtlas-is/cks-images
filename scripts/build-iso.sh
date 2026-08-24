#!/usr/bin/env bash
# Build a CloudStack Kubernetes Service (CKS) binaries ISO and optionally
# upload it to an S3-compatible bucket.
#
# Wraps upstream create-kubernetes-binaries-iso.sh from apache/cloudstack.
# The ISO layout is an interface consumed by the CloudStack release that
# deploys it: the release's node bootstrap applies specific files from the
# mounted ISO (dashboard.yaml, network.yaml, ...), so the build script must
# come from that release's tag, not from an arbitrary newer commit. The
# script is therefore fetched at the CLOUDSTACK_VERSION release tag, and the
# produced ISO name carries the CloudStack major.minor as a format marker
# (e.g. -cs4.22-) so artifacts for different release contracts can coexist.
#
# Required env:
#   K8S_VERSION           e.g. 1.33.1 (no leading v)
#   CNI_VERSION           e.g. 1.9.1
#   CRICTL_VERSION        e.g. 1.36.0
#   CNI_YAML_URL          e.g. Calico manifest URL
#   DASHBOARD_YAML_URL    kubernetes-dashboard manifest the ISO embeds,
#                         e.g. .../dashboard/v2.7.0/aio/deploy/recommended.yaml
#   CLOUDSTACK_VERSION    deployed CloudStack release, e.g. 4.22.1.0
#
# Optional env:
#   ARCH                  amd64 (default) | arm64
#   ETCD_VERSION          e.g. 3.5.15 (optional; 4.21+)
#   OUTPUT_DIR            defaults to ./output
#   S3_BUCKET             upload target; skip upload if unset
#   S3_ENDPOINT_URL       e.g. https://s3.runatlas.is
#   S3_PREFIX             key prefix inside bucket (default: cks/)
#   GPG_PASSPHRASE        optional passphrase for SIGNING_KEY in CI
#   UPSTREAM_REF          override the fetched apache/cloudstack ref; defaults
#                         to the CLOUDSTACK_VERSION release tag

set -euo pipefail

: "${K8S_VERSION:?K8S_VERSION is required}"
: "${CNI_VERSION:?CNI_VERSION is required}"
: "${CRICTL_VERSION:?CRICTL_VERSION is required}"
: "${CNI_YAML_URL:?CNI_YAML_URL is required}"
: "${DASHBOARD_YAML_URL:?DASHBOARD_YAML_URL is required}"
: "${CLOUDSTACK_VERSION:?CLOUDSTACK_VERSION is required}"

ARCH="${ARCH:-amd64}"
OUTPUT_DIR="${OUTPUT_DIR:-./output}"
S3_PREFIX="${S3_PREFIX:-cks/}"
UPSTREAM_REF="${UPSTREAM_REF:-refs/tags/${CLOUDSTACK_VERSION}}"
UPSTREAM_URL="https://raw.githubusercontent.com/apache/cloudstack/${UPSTREAM_REF}/scripts/util/create-kubernetes-binaries-iso.sh"
# Format marker: the CloudStack major.minor whose contract this ISO satisfies.
CS_FORMAT="$(cut -d. -f1-2 <<<"${CLOUDSTACK_VERSION}")"
BUILD_NAME="setup-v${K8S_VERSION}-calico-cs${CS_FORMAT}-${ARCH}"

mkdir -p "$OUTPUT_DIR"
workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

echo ">> Fetching upstream build script at ${UPSTREAM_REF}"
curl -fsSL "$UPSTREAM_URL" -o "$workdir/create-kubernetes-binaries-iso.sh"
chmod +x "$workdir/create-kubernetes-binaries-iso.sh"

# Interface assertion: the released script takes a dashboard manifest URL as
# its sixth argument and bundles it as dashboard.yaml, which the release's
# node bootstrap applies. Upstream main has already replaced this with a
# Headlamp version argument, so a wrong ref would silently build an ISO the
# deployed release cannot finish provisioning. Refuse anything that does not
# present the classic contract; a CloudStack upgrade that changes the
# contract must update this script and DASHBOARD_YAML_URL deliberately.
if ! grep -q 'DASHBOARD_YAML_CONFIG' "$workdir/create-kubernetes-binaries-iso.sh"; then
  echo "!! Upstream script at ${UPSTREAM_REF} does not take DASHBOARD_YAML_CONFIG;" >&2
  echo "!! its ISO layout does not match the CloudStack ${CLOUDSTACK_VERSION} contract." >&2
  exit 1
fi

echo ">> Building ISO for k8s=$K8S_VERSION arch=$ARCH cloudstack=$CLOUDSTACK_VERSION"
"$workdir/create-kubernetes-binaries-iso.sh" \
  "$OUTPUT_DIR" \
  "$K8S_VERSION" \
  "$CNI_VERSION" \
  "$CRICTL_VERSION" \
  "$CNI_YAML_URL" \
  "$DASHBOARD_YAML_URL" \
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

# Content gate: assert the ISO carries every file the deploying CloudStack
# release consumes before anything is signed or published. A missing entry
# here is exactly the failure mode that otherwise only surfaces as a tenant
# cluster stuck in Alert.
echo ">> Validating ISO contents"
listing="$(isoinfo -f -i "$iso_path")"
for required in dashboard.yaml network.yaml kubeadm kubectl kubelet; do
  if ! grep -qiE "(^|/)${required}" <<<"$listing"; then
    echo "!! ${iso_name} is missing ${required}; refusing to publish" >&2
    exit 1
  fi
done

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
