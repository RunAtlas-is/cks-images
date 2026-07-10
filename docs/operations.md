# Operations

## Daily Build

The `CKS images` workflow runs every day at 06:00 UTC and can also be started
manually from GitHub Actions.

By default it builds the latest stable patch release for the active Kubernetes
minor versions listed by endoflife.date. If the expected ISO object already
exists in object storage, the workflow skips rebuilding it and continues
with checksum signing, manifest generation, and site generation.

Manual inputs:

- `k8s_minor`: restrict the matrix to one minor, for example `1.33`.
- `force_rebuild`: rebuild the object even if it already exists.

Use `force_rebuild` only for an unpublished or explicitly revoked object. A CKS
ISO that has already been registered in CloudStack should be treated as
immutable because CloudStack supported versions point at a specific URL and
checksum.

## Artifact Storage

GitHub stores the source, workflow, and static catalog. ISO artifacts live in
S3-compatible object storage because GitHub is not a good fit for multi-GB
tenant installation media.

Configure the object store with generic repository secrets:

- `S3_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY`

Configure the target with generic repository variables:

- `S3_BUCKET`
- `S3_ENDPOINT_URL`
- `S3_PREFIX`
- `ARTIFACT_BASE_URL`

Grant the publish identity only the required object-store actions. For S3-style
policy names, that means:

- `s3:ListBucket` on the bucket, constrained to the configured prefix.
- `s3:GetObject` on objects under the configured prefix for existence checks,
  checksum refresh, and catalog generation.
- `s3:PutObject` on objects under the configured prefix for ISOs, SHA-256
  files, signatures, and per-minor checksum sets.
- `s3:PutObject` on `keys/atlas-cloud-artifact-signing.asc` when the public
  signing key is mirrored into object storage.
- Multipart upload actions for large ISO writes: `s3:AbortMultipartUpload`,
  `s3:ListMultipartUploadParts`, and `s3:ListBucketMultipartUploads`.

The publish identity does not need object deletion, bucket policy, ACL,
lifecycle, or bucket administration permissions.

Current public object paths:

- `https://s3.runatlas.is/atlas-static-assets/cks/setup-v<version>-calico-amd64-x86_64.iso`
- `https://s3.runatlas.is/atlas-static-assets/cks/setup-v<version>-calico-amd64-x86_64.iso.sha256`
- `https://s3.runatlas.is/atlas-static-assets/cks/setup-v<version>-calico-amd64-x86_64.iso.asc`
- `https://s3.runatlas.is/atlas-static-assets/cks/CHECKSUM-<minor>`
- `https://s3.runatlas.is/atlas-static-assets/cks/CHECKSUM-<minor>.asc`

The GitHub Pages catalog and `manifest.json` are generated from the bucket
listing. They do not publish index files back into object storage.

## CloudStack Availability

The scheduled workflow publishes and indexes artifacts. CloudStack registration
uses the Pages manifest:

- <https://runatlas-is.github.io/cks-images/manifest.json>
- <https://runatlas-is.github.io/cks-images/cks/manifest.json>

The preferred CloudStack integration is an internal pull job that verifies the
manifest checksum signatures and calls the CloudStack API. The manual
`register_cloudstack` workflow input runs the same sync from GitHub Actions
through the `cloudstack-registration` environment when a CloudStack operator
chooses that model.

New ISOs should still be treated as immutable once published. When a CloudStack
operator later registers a URL/checksum pair, changing the object under that URL
invalidates the supported-version record.

## Signing

Every ISO gets a detached GPG signature when the signing key is available in CI.
`scripts/sign-artifacts.sh` also regenerates one signed checksum set per
Kubernetes minor.

The bucket prefix is shared storage, so presence in the bucket is not treated
as provenance. The sign step only signs and lists an ISO when its digest is
established by the current run's build manifest (emitted by the build job), by
an entry in an already-published `CHECKSUM-<minor>` whose signature verifies
against the pinned fingerprint, or by an existing `.asc` on the ISO that
verifies against the pinned key. Any other ISO object under the prefix is
skipped, excluded from the checksum sets, and fails the run so the object can
be investigated and removed. When running the script outside CI, pass
`BUILT_DIGESTS_FILE` (lines of `sha256  filename`) for ISOs that are not yet
covered by a signed checksum set.

Required GitHub secrets:

- `GPG_PRIVATE_KEY_B64`
- `GPG_PASSPHRASE` if the key is passphrase protected

The public key is committed at `keys/atlas-cloud-artifact-signing.asc` and is
included in the GitHub Pages artifact. CI also syncs it to object storage at
`keys/atlas-cloud-artifact-signing.asc`.

## Local Builds

Local builds use the same script as CI:

```bash
export K8S_VERSION=1.33.11
export CNI_VERSION=1.9.1
export CRICTL_VERSION=1.36.0
export HEADLAMP_VERSION=0.43.0
export CNI_YAML_URL=https://raw.githubusercontent.com/projectcalico/calico/v3.32.1/manifests/calico.yaml

./scripts/build-iso.sh
```

To upload locally, also set:

```bash
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
export S3_BUCKET=atlas-static-assets
export S3_ENDPOINT_URL=https://s3.runatlas.is
export S3_PREFIX=cks/
```

To refresh signatures/checksums for existing bucket objects:

```bash
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
export AWS_ENDPOINT_URL=https://s3.runatlas.is
export BUCKET_NAME=atlas-static-assets
export S3_PREFIX=cks/
export SIGNING_KEY=artifacts@runatlas.is

./scripts/sign-artifacts.sh
```
