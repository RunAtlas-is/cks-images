# CloudStack Integration

This repository builds and publishes CKS binaries ISOs. CloudStack consumes the
published manifest and registers selected ISO URLs as supported Kubernetes
versions for tenant clusters.

Apache CloudStack documents this as the CKS supported-version registry:
`addKubernetesSupportedVersion` registers an ISO URL, semantic version, checksum,
zone, and minimum resources; `listKubernetesSupportedVersions` lists registered
versions; `updateKubernetesSupportedVersion` enables or disables an existing
version. See the upstream CloudStack Kubernetes Service docs:

<https://docs.cloudstack.apache.org/en/latest/plugins/cloudstack-kubernetes-service.html#kubernetes-supported-versions>

## CloudStack Release Contract

The ISO layout is an interface consumed by the deployed CloudStack release:
its node bootstrap applies specific files from the mounted ISO
(`dashboard.yaml`, `network.yaml`, binaries), and the management server then
waits for the workloads those files create. An ISO built with a build script
from a different CloudStack release can bootstrap a working control plane and
still fail cluster creation, because the file the deployed release applies is
absent.

The build therefore pins everything to `CLOUDSTACK_VERSION` (repository
variable, workflow default): the upstream `create-kubernetes-binaries-iso.sh`
is fetched at that release tag, the build asserts the fetched script's
argument contract and the produced ISO's content before publishing, and
artifact names carry the CloudStack major.minor as a format marker
(`setup-v<k8s>-calico-cs<major.minor>-<arch>-<machine>.iso`). The manifest
offers only images whose marker matches its `cloudstackFormat`; unmarked or
foreign-format artifacts remain listed for download but are never registered.

Upgrading CloudStack across a format boundary means bumping
`CLOUDSTACK_VERSION`, letting CI rebuild the active matrix under the new
marker, and letting the sync register the rebuilt artifacts and retire the
drifted ones. Nothing else needs coordinating.

## Registration Policy

Use one CloudStack supported version per Kubernetes patch version.

- New CI-built patch ISOs are immutable artifacts.
- New tenant clusters should default to the newest enabled patch for the chosen
  Kubernetes minor after it has been built, signed, and registered.
- Existing tenant clusters should not be upgraded transparently. Patch upgrades
  should be explicit tenant/admin actions through CloudStack's
  `upgradeKubernetesCluster` API after basic validation.
- Do not use `force_rebuild` for a patch version that is already registered in
  CloudStack unless the old object is intentionally revoked and the registration
  is repaired manually.

CloudStack supports upgrading a running CloudManaged Kubernetes cluster by
passing the target supported-version ID to `upgradeKubernetesCluster`:

<https://cloudstack.apache.org/api/apidocs-4.22/apis/upgradeKubernetesCluster.html>

## Version Lifecycle

The sync script drives the full state lifecycle of registered versions. Each
run applies these rules per zone, only to versions whose semantic version
appears in the manifest for the selected arch; operator-registered custom
versions are never touched:

- **Register**: the newest patch of every in-support minor
  (`--latest-per-minor`) whose manifest artifact is not yet registered. A
  registered entry counts only when it points at the manifest's ISO URL; a
  same-version entry pointing at another artifact is a stale build. The ISO
  downloads through the zone's secondary storage VM and the version becomes
  usable when the ISO reaches `Ready`.
- **Disable drifted**: an entry whose ISO URL differs from the manifest's
  artifact for the same version is disabled as soon as the manifest's own
  artifact is `Ready`, so a rebuild (for example after a CloudStack format
  bump) replaces the stale registration without a gap.
- **Disable superseded** (`--disable-superseded`): once a newer patch of the
  same minor has a `Ready` ISO, older enabled patches of that minor are
  disabled. The replacement being `Ready` is a precondition, so tenant capacity
  never shrinks before its successor is usable. This also covers orphaned
  entries: a registered version the manifest no longer offers is still
  pipeline-owned when its ISO URL lives under the manifest's artifact store
  (as after a format bump renames the matrix), and retires the same way.
  Entries pointing anywhere else are operator-registered and never touched.
- **Disable EOL** (`--disable-eol`): enabled versions whose Kubernetes minor is
  past its manifest `lifecycle.eol` date are disabled.
- **Stall detection** (`--fail-on-stalled`): a registered version whose ISO is
  still not `Ready` after `--stalled-after-hours` (default 12, env
  `CKS_STALLED_AFTER_HOURS`) makes the run exit non-zero so the scheduler's
  failure alerting fires.

Disabling is non-destructive: running clusters keep working and can still
upgrade to a newer enabled version; only new-cluster creation on the disabled
version is blocked. Deleting versions (`deleteKubernetesSupportedVersion`) and
revoking artifacts stay manual operator actions, taken only for disabled
versions with no clusters still referencing them. Cluster upgrades also stay
explicit (`upgradeKubernetesCluster`); the sync never touches clusters.

## Registration Model

The preferred registration model is pull-based:

1. GitHub Actions builds, signs, and publishes ISOs plus the Pages catalog.
2. The Pages catalog includes `manifest.json`.
3. A job inside the CloudStack operator environment fetches the manifest,
   verifies the signed checksum sets, and calls the CloudStack API.

This keeps CloudStack API credentials inside the operator network and makes the
GitHub workflow an artifact publisher, not a CloudStack mutator.

Manifest URLs:

- <https://runatlas-is.github.io/cks-images/manifest.json>
- <https://runatlas-is.github.io/cks-images/cks/manifest.json>

Run the puller from a host that can reach the CloudStack API. Set these
environment variables:

- `CLOUDSTACK_ENDPOINT`
- `CLOUDSTACK_API_KEY`
- `CLOUDSTACK_SECRET_KEY`
- `CLOUDSTACK_ZONE_ID` or comma-separated `CLOUDSTACK_ZONE_IDS`

Optional environment variables:

- `CKS_MIN_CPU`, default `2`
- `CKS_MIN_MEMORY`, default `2048`
- `CKS_ARCH`, default `x86_64`
- `CKS_DIRECT_DOWNLOAD`, default `false`
- `CKS_MANIFEST_URL`, default `https://runatlas-is.github.io/cks-images/manifest.json`
- `GPG_SIGNING_FINGERPRINT`

Example:

```bash
mkdir -p .cache
python3 -m venv .cache/cloudstack-venv
.cache/cloudstack-venv/bin/python -m pip install cs

.cache/cloudstack-venv/bin/python \
  scripts/sync-cloudstack-supported-versions.py \
  --manifest-url https://runatlas-is.github.io/cks-images/manifest.json \
  --zone-id "${CLOUDSTACK_ZONE_ID}" \
  --dry-run
```

Remove `--dry-run` after the selected versions and zones look correct. Useful
filters:

```bash
.cache/cloudstack-venv/bin/python \
  scripts/sync-cloudstack-supported-versions.py --minor 1.34
.cache/cloudstack-venv/bin/python \
  scripts/sync-cloudstack-supported-versions.py --version 1.34.7
.cache/cloudstack-venv/bin/python \
  scripts/sync-cloudstack-supported-versions.py --latest-per-minor
```

The lower-level one-version helper supports manual repair:

```bash
python3 scripts/register-cloudstack-version.py \
  --version 1.34.7 \
  --url "https://s3.runatlas.is/atlas-static-assets/cks/<iso>" \
  --checksum "<sha256>" \
  --zone-id "${CLOUDSTACK_ZONE_ID}"
```

The `CKS images` workflow also has a manual `register_cloudstack` input. It runs
the same puller after Pages deploy through the `cloudstack-registration`
environment. Use that path only with an environment-protected CloudStack service
account.

## Minimum CloudStack Role

The CloudStack API role behind the sync account is an admin/root-admin role type
with only these API rules allowed:

- `listKubernetesSupportedVersions`
- `addKubernetesSupportedVersion`
- `updateKubernetesSupportedVersion`

API references:

- <https://cloudstack.apache.org/api/apidocs-4.22/apis/listKubernetesSupportedVersions.html>
- <https://cloudstack.apache.org/api/apidocs-4.22/apis/addKubernetesSupportedVersion.html>
- <https://cloudstack.apache.org/api/apidocs-4.22/apis/updateKubernetesSupportedVersion.html>

Avoid these permissions in the daily sync account:

- `deleteKubernetesSupportedVersion`
- `listZones`, because zone IDs are supplied by local configuration
- Cluster lifecycle APIs such as `upgradeKubernetesCluster`,
  `createKubernetesCluster`, and `deleteKubernetesCluster`

CloudStack roles allow or deny named APIs and wildcard API patterns:

<https://docs.cloudstack.apache.org/en/4.22.0.0/adminguide/accounts.html>

Delete reference for cleanup-only roles:

<https://cloudstack.apache.org/api/apidocs-4.22/apis/deleteKubernetesSupportedVersion.html>

## Tenant API Endpoint

CKS injects a `cloudstack-secret` into tenant clusters. That secret contains the
CloudStack API URL used by the CloudStack cloud-controller-manager and the
CloudStack CSI driver. CloudStack takes the URL from the global `endpoint.url`
setting, and the URL must be reachable from pods inside the tenant Kubernetes
network.

For Atlas Cloud, `endpoint.url` is the public DNS name and HTTPS API path:

```text
https://sky.atlascloud.is/client/api
```

Tenant cluster nodes reach this name through their isolated network's source
NAT address and public DNS, with no DNS override, and the certificate matches
the hostname. An internal management address is not a valid value: tenant
networks cannot route to it, and `LoadBalancer` reconciliation times out when
the controller tries to call CloudStack.

The invariant is that `endpoint.url` is an HTTPS CloudStack API URL that CKS
nodes and pods can reach, not a management-only address.

CloudStack creates the secret only when it is absent, so a changed
`endpoint.url` reaches newly created clusters only. An existing cluster keeps
the URL it was created with until its `cloudstack-secret` is deleted and
regenerated. CloudStack maintainers point to `/opt/bin/deploy-cloudstack-secret`
on the control node for redeploying the generated secret:

<https://github.com/apache/cloudstack/discussions/9267>

Validation on an affected cluster:

```bash
kubectl -n kube-system get secret cloudstack-secret \
  -o jsonpath='{.data.cloud-config}' | base64 -d | grep '^api-url'
kubectl -n kube-system logs deployment/cloud-controller-manager --tail=50
```

The first command prints only the URL line; the secret also holds the
account's API and secret keys.

The secret should contain the tenant-routable API URL, and creating a
`Service` of type `LoadBalancer` should list and create CloudStack load
balancer rules without timing out.

## Cloud Controller Manager

CKS deploys the CloudStack cloud controller manager (CCM), the component that
turns a `LoadBalancer` Service into CloudStack load balancer rules, from the
binaries ISO. The upstream ISO build script bundles `provider.yaml` from the
`main` branch of `apache/cloudstack-kubernetes-provider` together with the
image it names, `apache/cloudstack-kubernetes-provider:v1.2.0`. When a cluster
is created, the control node copies `provider.yaml` to `/opt/provider/` and
CloudStack's `deploy-provider` script applies it, unless a
`cloud-controller-manager` pod already exists. `upgradeKubernetesCluster`
imports the new ISO's images and copies its `provider.yaml`, but does not apply
it, so an upgrade never changes a running cluster's controller.

The v1.2.0 controller calls `listManagementServersMetrics` at start-up. That
API is root-admin only, so for every tenant account the call fails with error
432 and the controller exits; tenant clusters then get no load balancer
addresses
([apache/cloudstack-kubernetes-provider#94](https://github.com/apache/cloudstack-kubernetes-provider/issues/94)).
Upstream commit
[`5147f76`](https://github.com/apache/cloudstack-kubernetes-provider/commit/5147f76478f66191513d8741ffd8800a35684fc2)
replaces the call with `listCapabilities`; no release contains it.

### Pinned controller in the ISOs

The `CCM image` workflow (`.github/workflows/ccm-image.yml`) builds the
upstream source at a pinned commit and publishes it as
`ghcr.io/runatlas-is/cloudstack-kubernetes-provider`, tagged with the commit.
Nodes pull it anonymously, so the GHCR package must be public.

Two variables in `.github/workflows/cks-images.yml` select the controller the
ISOs deploy:

- `CCM_IMAGE`: the published image by digest,
  `ghcr.io/runatlas-is/cloudstack-kubernetes-provider@sha256:<digest>`.
- `CCM_SOURCE_COMMIT`: the upstream commit the image was built from. The ISO
  takes `deployment.yaml` from that commit and replaces its image line with
  `CCM_IMAGE`.

When both are empty, ISOs keep the upstream manifest and the v1.2.0 image.
When set, `scripts/build-iso.sh` refuses to publish an ISO whose
`provider.yaml` does not name `CCM_IMAGE` or that lacks the image archive, and
the artifact name carries a CCM marker, the first 12 hex digits of the image
digest:

```text
setup-v<k8s>-calico-cs<major.minor>-ccm<digest12>-<arch>-<machine>.iso
```

A new marker gives every active Kubernetes patch a new artifact URL, so the
next build rebuilds the whole matrix instead of overwriting ISOs that
CloudStack already registered. The manifest offers one artifact per version:
the one with the current marker, else the unmarked build. The sync then
registers the marked artifacts and disables the previous registrations once the
replacements are `Ready` (see [Version Lifecycle](#version-lifecycle)).

Setting or changing `CCM_IMAGE` therefore changes what new clusters run in
every zone the sync serves, within one build and one sync run. Treat it as a
production change. To roll back, first re-enable the earlier entries
(`updateKubernetesSupportedVersion state=Enabled`), because the sync disabled
them and does not re-enable an entry without `--enable-existing`. Then restore
the previous values: the next build publishes a manifest that falls back to the
earlier artifacts, and the next sync disables the marked entries.

### Existing clusters

A cluster keeps the controller it was created with. To move an existing
cluster to the pinned controller, use the cluster's kubeconfig
(`getKubernetesClusterConfig`) and patch the deployment in place. Its
`cloudstack-secret` must already name a tenant-reachable `api-url` (see
[Tenant API Endpoint](#tenant-api-endpoint)).

```bash
NEW_IMAGE='ghcr.io/runatlas-is/cloudstack-kubernetes-provider@sha256:<digest>'
K='kubectl -n kube-system'

# Prints only the URL line, never the keys.
$K get secret cloudstack-secret -o jsonpath='{.data.cloud-config}' \
  | base64 -d | grep '^api-url'

# The current image is the rollback value.
$K get deployment cloud-controller-manager \
  -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'

$K set image deployment/cloud-controller-manager \
  cloud-controller-manager="$NEW_IMAGE"
$K rollout status deployment/cloud-controller-manager --timeout=300s
$K logs deployment/cloud-controller-manager --tail=30
```

The logs must not show error 432. A `LoadBalancer` Service then receives an
external address within a few minutes. CKS does not reapply `provider.yaml`
to a cluster that has a controller pod, and upgrades do not apply it, so the
patch persists. To roll back, run the same `set image` with the recorded
previous image.

