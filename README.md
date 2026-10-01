# CKS Images

Kubernetes binaries ISOs for the Apache CloudStack Kubernetes Service (CKS),
and the pipeline that builds, signs, and publishes them.

Each ISO is built with the upstream CloudStack ISO script at the release tag of
the CloudStack version it targets, and can carry a cloud controller manager
(CCM) that works for non-admin CloudStack accounts. The ISOs hold no value
specific to one CloudStack installation: each cluster receives its CloudStack
API address from the CloudStack global setting `endpoint.url` when it is
created, so the same ISO serves any CloudStack deployment of the matching
release.

## Published Images

Atlas Cloud builds the active Kubernetes matrix daily and publishes it here:

- Catalog: <https://runatlas-is.github.io/cks-images/>
- Manifest for automated registration:
  <https://runatlas-is.github.io/cks-images/manifest.json>
- Artifacts: <https://s3.runatlas.is/atlas-static-assets/cks/>
- Signing key:
  <https://runatlas-is.github.io/cks-images/keys/atlas-cloud-artifact-signing-2026.asc>
- Previous signing key, valid for artifacts signed before 2026-09-13:
  <https://runatlas-is.github.io/cks-images/keys/atlas-cloud-artifact-signing.asc>
- Key transition statement, signed by both keys:
  <https://runatlas-is.github.io/cks-images/keys/atlas-artifact-signing-key-transition-2026.txt.asc>
- Cloud controller manager image:
  `ghcr.io/runatlas-is/cloudstack-kubernetes-provider`

Artifact names state what each ISO contains:

```text
setup-v<k8s>-calico-cs<major.minor>[-ccm<digest12>]-<arch>-<machine>.iso
```

`cs<major.minor>` is the CloudStack release whose ISO layout the image follows,
and `-ccm<digest12>` names the first 12 hex digits of the controller image
digest the ISO deploys. Every ISO has a `.sha256` file and a detached `.asc`
signature, and every Kubernetes minor has a signed `CHECKSUM-<minor>` set.

## Using the Images in CloudStack

1. Set `endpoint.url` to a CloudStack API URL that tenant cluster nodes can
   reach ([CloudStack API address](docs/cloudstack-integration.md#cloudstack-api-address)).
2. Register the ISOs as CKS supported versions, by hand or with the manifest
   sync ([Registering versions](docs/cloudstack-integration.md#registering-versions)).
3. Create clusters as usual. To move a cluster created earlier to the API
   address or controller described here, follow
   [Existing clusters](docs/cloudstack-integration.md#existing-clusters).

Use the ISOs only on the CloudStack release named by their `cs<major.minor>`
marker ([CloudStack release contract](docs/cloudstack-integration.md#cloudstack-release-contract)).

## Building the Images

`scripts/build-iso.sh` builds one ISO locally, with no credentials:

```bash
export K8S_VERSION=1.34.12
export CNI_VERSION=1.9.1
export CRICTL_VERSION=1.36.0
export CLOUDSTACK_VERSION=4.22.1.0
export DASHBOARD_YAML_URL=https://raw.githubusercontent.com/kubernetes/dashboard/v2.7.0/aio/deploy/recommended.yaml
export CNI_YAML_URL=https://raw.githubusercontent.com/projectcalico/calico/v3.32.1/manifests/calico.yaml

./scripts/build-iso.sh
```

The script needs `curl`, `jq`, `genisoimage` (for `mkisofs` and `isoinfo`), a
running `containerd`, and `sudo` for `ctr`, which pulls the bundled images. It
writes the ISO and its `.sha256` file to `./output`; set `ARCH=arm64` for an
arm64 image. Run it once per Kubernetes version. To ship a
specific cloud controller manager, also set `CCM_IMAGE` and
`CCM_SOURCE_COMMIT` ([Cloud controller manager](docs/cloudstack-integration.md#cloud-controller-manager)).

To run the whole daily pipeline in a fork, with its own object storage,
signing key, and catalog, see [Running the pipeline](docs/operations.md#running-the-pipeline).

## Layout

```text
.
├── .github/workflows/cks-images.yml    daily builds, signing, Pages deploy
├── .github/workflows/ccm-image.yml     cloud controller manager image
├── .github/workflows/ci.yml            pull request and main validation
├── .github/workflows/workflow-lint.yml actionlint and zizmor over the workflows
├── docs/                               operations and CloudStack integration
├── index/                              Bun static catalog generator
├── keys/                               public artifact signing keys
└── scripts/
    ├── build-iso.sh                    build and optionally upload one ISO
    ├── register-cloudstack-version.py  register one CloudStack supported version
    ├── sign-artifacts.sh               sign bucket ISOs and checksums
    └── sync-cloudstack-supported-versions.py  pull the manifest into CloudStack
```

## Documentation

- [docs/cloudstack-integration.md](docs/cloudstack-integration.md): API
  address, version registration, cloud controller manager, existing clusters,
  upgrade and rollback.
- [docs/operations.md](docs/operations.md): the build, signing, storage, and
  catalog pipeline and its configuration.
