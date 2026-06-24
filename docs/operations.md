# Operations

## Daily Build

The `CKS images` workflow runs every day at 06:00 UTC and can also be started
manually from GitHub Actions.

By default it builds the latest stable patch release for the active Kubernetes
minor versions listed by endoflife.date. If the expected ISO object already
exists in Atlas object storage, the workflow skips rebuilding it and continues
with checksum signing and site generation.

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

Current public object paths:

- `https://s3.runatlas.is/atlas-static-assets/cks/setup-v<version>-calico-amd64-x86_64.iso`
- `https://s3.runatlas.is/atlas-static-assets/cks/setup-v<version>-calico-amd64-x86_64.iso.sha256`
- `https://s3.runatlas.is/atlas-static-assets/cks/setup-v<version>-calico-amd64-x86_64.iso.asc`
- `https://s3.runatlas.is/atlas-static-assets/cks/CHECKSUM-<minor>`
- `https://s3.runatlas.is/atlas-static-assets/cks/CHECKSUM-<minor>.asc`

The GitHub Pages catalog is generated from the bucket listing. It does not
publish index files back into object storage.

## CloudStack Availability

The scheduled workflow stops at publishing and indexing artifacts. Registering
the resulting ISO URLs as CloudStack supported Kubernetes versions is a separate
integration step covered in [cloudstack-integration.md](cloudstack-integration.md).

New ISOs should still be treated as immutable once published. When a CloudStack
operator later registers a URL/checksum pair, changing the object under that URL
will invalidate the supported-version record.

## Signing

Every ISO gets a detached GPG signature when the signing key is available in CI.
`scripts/sign-artifacts.sh` also regenerates one signed checksum set per
Kubernetes minor.

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
export CNI_VERSION=1.6.2
export CRICTL_VERSION=1.33.0
export HEADLAMP_VERSION=0.25.0
export CNI_YAML_URL=https://raw.githubusercontent.com/projectcalico/calico/v3.29.0/manifests/calico.yaml

./scripts/build-iso.sh
```

To upload locally, also set:

```bash
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
export S3_BUCKET=atlas-static-assets
export S3_ENDPOINT_URL=https://s3.runatlas.is
```

To refresh signatures/checksums for existing bucket objects:

```bash
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
export AWS_ENDPOINT_URL=https://s3.runatlas.is
export BUCKET_NAME=atlas-static-assets
export SIGNING_KEY=artifacts@runatlas.is

./scripts/sign-artifacts.sh
```
