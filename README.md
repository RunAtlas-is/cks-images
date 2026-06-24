# CKS Images

Build, sign, publish, and index CloudStack Kubernetes Service (CKS) binaries
ISOs for Atlas Cloud.

The source of truth for the builder lives in this repository. GitHub Actions
runs the daily build matrix, stores ISO artifacts in Atlas object storage, and
publishes the static catalog through GitHub Pages.

- Catalog: <https://runatlas-is.github.io/cks-images/>
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
    ├── register-cloudstack-version.py idempotent CloudStack registration
    └── sign-artifacts.sh              sign bucket ISOs and checksums
```

## CI Ownership

The scheduled workflow runs daily at 06:00 UTC. It:

1. Resolves the active Kubernetes minor matrix from endoflife.date.
2. Builds the latest stable patch ISO for each active minor when missing.
3. Uploads ISOs, SHA-256 files, and detached signatures to Atlas object storage.
4. Regenerates signed `CHECKSUM-<minor>` files.
5. Builds the static catalog and deploys it to GitHub Pages.
6. Optionally registers the published ISO as a CloudStack supported Kubernetes
   version when CloudStack API credentials and a zone ID are configured.

## Required Secrets

Repository secrets:

- `ATLAS_S3_ACCESS_KEY_ID`
- `ATLAS_S3_SECRET_ACCESS_KEY`
- `ATLAS_CKS_GPG_PRIVATE_KEY`
- `ATLAS_CKS_GPG_PASSPHRASE` when the key is passphrase protected

Optional repository secrets for CloudStack registration:

- `ATLAS_CLOUDSTACK_API_KEY`
- `ATLAS_CLOUDSTACK_SECRET_KEY`

Repository variables:

- `ATLAS_CLOUDSTACK_ZONE_ID` enables CloudStack registration.
- `ATLAS_CLOUDSTACK_ENDPOINT` overrides the default `https://sky.runatlas.is/client/api`.
- `ATLAS_CKS_MIN_CPU` and `ATLAS_CKS_MIN_MEMORY` override the default supported
  version constraints (`2`, `2048`).

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
