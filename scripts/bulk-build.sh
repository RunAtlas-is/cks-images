#!/usr/bin/env bash
# Serially build and upload CKS ISOs for a list of Kubernetes versions.
# Idempotent: skips versions whose object already exists in the bucket.
#
# Usage (with S3 credentials already sourced):
#   ./bulk-build.sh 1.33.1 1.33.2 1.34.1 ...
#
# Required env: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_ENDPOINT_URL,
# BUCKET_NAME.
# Optional env: CNI_VERSION, CRICTL_VERSION, HEADLAMP_VERSION, CNI_YAML_URL
# override the pinned defaults.

set -euo pipefail

: "${AWS_ACCESS_KEY_ID:?}"
: "${AWS_SECRET_ACCESS_KEY:?}"
: "${AWS_ENDPOINT_URL:?}"
: "${BUCKET_NAME:?}"

export CNI_VERSION="${CNI_VERSION:-1.9.1}"
export CRICTL_VERSION="${CRICTL_VERSION:-1.36.0}"
export HEADLAMP_VERSION="${HEADLAMP_VERSION:-0.43.0}"
export CNI_YAML_URL="${CNI_YAML_URL:-https://raw.githubusercontent.com/projectcalico/calico/v3.32.1/manifests/calico.yaml}"
export S3_BUCKET="${S3_BUCKET:-$BUCKET_NAME}"
export S3_ENDPOINT_URL="${S3_ENDPOINT_URL:-$AWS_ENDPOINT_URL}"
export S3_PREFIX="${S3_PREFIX:-cks/}"
REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
: "${OUTPUT_DIR:=${REPO_ROOT}/output}"
export OUTPUT_DIR

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$OUTPUT_DIR"

# Distinguish "object does not exist" (build it) from "cannot talk to S3"
# (abort the whole bulk run so we do not mask a genuine outage).
aws_head() {
  local out rc
  out=$(aws --endpoint-url "$AWS_ENDPOINT_URL" \
    s3api head-object --bucket "$BUCKET_NAME" --key "$1" 2>&1)
  rc=$?
  if [[ $rc -eq 0 ]]; then return 0; fi
  if [[ "$out" == *"Not Found"* || "$out" == *"NoSuchKey"* || "$out" == *"404"* ]]; then
    return 1
  fi
  echo "!! head-object failed for $1 (rc=$rc): $out" >&2
  exit 2
}

# Reclaim ISO build artifacts between versions: containerd images, /tmp scratch,
# and any previous ISO in $OUTPUT_DIR. Each ISO already embeds the images it needs.
reclaim() {
  rm -f "$OUTPUT_DIR"/setup-v*.iso "$OUTPUT_DIR"/setup-v*.sha256
  sudo rm -rf /tmp/iso /tmp/cri-tools /tmp/k8s 2>/dev/null || true
  if command -v ctr >/dev/null 2>&1; then
    # containerd uses a separate content store under /var/lib/containerd;
    # removing the image refs dereferences layers so gc reclaims the bytes.
    # Pipe the newline-separated ref list into `xargs -d '\n'` so a space in
    # a reference can't cause word-splitting, and surface non-fatal failures
    # on stderr instead of swallowing them with `|| true`.
    if ! sudo ctr -n default image ls -q 2>/dev/null \
         | xargs -r -d '\n' sudo ctr -n default image rm >/dev/null 2>&1; then
      echo "[reclaim] ctr image rm returned non-zero (continuing)" >&2
    fi
    sudo ctr -n default content prune references 2>/dev/null \
      || echo "[reclaim] ctr content prune references non-zero (continuing)" >&2
  fi
  # If docker ended up in the loop (some versions of the upstream script probe for it),
  # prune it too; no-op when docker is absent.
  if command -v docker >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1; then
    sudo docker system prune -af --volumes >/dev/null 2>&1 || true
  fi
}

disk_status() {
  df -h --output=used,avail,pcent / | awk 'NR==2 { printf "[disk] used=%s free=%s pct=%s\n", $1, $2, $3 }'
}

disk_status
for V in "$@"; do
  prefix="${S3_PREFIX#/}"
  if [[ -n "$prefix" && "$prefix" != */ ]]; then
    prefix="${prefix}/"
  fi
  KEY="${prefix}setup-v${V}-calico-amd64-x86_64.iso"
  if aws_head "$KEY"; then
    echo "[skip] $KEY already present"
    continue
  fi
  echo "[build] k8s=$V -> $KEY"
  reclaim
  K8S_VERSION="$V" "$SCRIPT_DIR/build-iso.sh"
  echo "[done] $V"
  reclaim
  disk_status
done

echo "[bulk] all requested versions processed"
