# CKS Images

Build, sign, publish, and index CloudStack Kubernetes Service (CKS) binaries
ISOs.

The source of truth for the builder lives in this repository. GitHub Actions
runs the daily build matrix, stores ISO artifacts in S3-compatible storage, and
publishes the static catalog through GitHub Pages.

- Catalog: <https://runatlas-is.github.io/cks-images/>
- Manifest: <https://runatlas-is.github.io/cks-images/manifest.json>
- Artifacts: <https://s3.runatlas.is/atlas-static-assets/cks/>
- Public signing key: <https://runatlas-is.github.io/cks-images/keys/atlas-cloud-artifact-signing.asc>

## Layout

```text
.
├── .github/workflows/cks-images.yml   daily builds, signing, Pages deploy
├── docs/                              operations and CloudStack integration
├── index/                             Bun static catalog generator
├── keys/                              public artifact signing key
└── scripts/
    ├── build-iso.sh                   build and optionally upload one ISO
    ├── bulk-build.sh                  local helper for multiple versions
    ├── register-cloudstack-version.py register one CloudStack supported version
    ├── sign-artifacts.sh              sign bucket ISOs and checksums
    └── sync-cloudstack-supported-versions.py pull manifest into CloudStack
```

## CI Ownership

The scheduled workflow runs daily at 06:00 UTC. It:

1. Resolves the active Kubernetes minor matrix from endoflife.date.
2. Builds the latest stable patch ISO for each active minor when missing.
3. Uploads ISOs, SHA-256 files, and detached signatures to S3-compatible
   object storage.
4. Regenerates signed `CHECKSUM-<minor>` files.
5. Builds the static catalog plus `manifest.json` and deploys both to GitHub
   Pages.

## Required Secrets

Repository secrets:

- `S3_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY`
- `GPG_PRIVATE_KEY_B64`
- `GPG_PASSPHRASE` when the key is passphrase protected

Repository variables:

- `S3_BUCKET`, default `atlas-static-assets`
- `S3_ENDPOINT_URL`, default `https://s3.runatlas.is`
- `S3_PREFIX`, default `cks/`
- `ARTIFACT_BASE_URL`, default `https://s3.runatlas.is/atlas-static-assets`
- `SITE_BASE_URL`, default `https://runatlas-is.github.io/cks-images`
- `DOCS_URL`
- `GPG_SIGNING_KEY`, default `artifacts@runatlas.is`
- `GPG_SIGNING_FINGERPRINT`

Optional `cloudstack-registration` environment secrets for the manual
`register_cloudstack` workflow input:

- `CLOUDSTACK_API_KEY`
- `CLOUDSTACK_SECRET_KEY`

Optional `cloudstack-registration` environment variables:

- `CLOUDSTACK_ENDPOINT`
- `CLOUDSTACK_ZONE_ID` or `CLOUDSTACK_ZONE_IDS`

## Local Use

```bash
export K8S_VERSION=1.33.11
export CNI_VERSION=1.6.2
export CRICTL_VERSION=1.33.0
export HEADLAMP_VERSION=0.25.0
export CNI_YAML_URL=https://raw.githubusercontent.com/projectcalico/calico/v3.29.0/manifests/calico.yaml

./scripts/build-iso.sh
```

Set `S3_BUCKET`, `S3_ENDPOINT_URL`, `AWS_ACCESS_KEY_ID`, and
`AWS_SECRET_ACCESS_KEY` to upload from a local run.

See [docs/operations.md](docs/operations.md) and
[docs/cloudstack-integration.md](docs/cloudstack-integration.md) for the
operational policy.
