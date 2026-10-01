# CloudStack Integration

This guide is for a CloudStack operator who runs these ISOs in CKS: how to
point clusters at the CloudStack API, register the ISOs as supported versions,
choose the cloud controller manager, bring existing clusters in line, and
upgrade or roll back each of these.

Apache CloudStack documents the CKS supported-version registry:
`addKubernetesSupportedVersion` registers an ISO URL, semantic version,
checksum, zone, and minimum resources; `listKubernetesSupportedVersions` lists
registered versions; `updateKubernetesSupportedVersion` enables or disables a
registered version.

<https://docs.cloudstack.apache.org/en/latest/plugins/cloudstack-kubernetes-service.html#kubernetes-supported-versions>

## CloudStack Release Contract

The ISO layout is an interface consumed by the deployed CloudStack release:
its node bootstrap applies specific files from the mounted ISO
(`dashboard.yaml`, `network.yaml`, `provider.yaml`, binaries), and the
management server then waits for the workloads those files create. An ISO built
with a build script from a different CloudStack release can bootstrap a working
control plane and still fail cluster creation, because the file the deployed
release applies is absent.

The build therefore pins everything to `CLOUDSTACK_VERSION`: the upstream
`create-kubernetes-binaries-iso.sh` is fetched at that release tag, the build
asserts the fetched script's argument contract and the produced ISO's content
before publishing, and artifact names carry the CloudStack major.minor as a
format marker (`-cs<major.minor>-`). The manifest offers only images whose
marker matches its `cloudstackFormat`; unmarked or foreign-format artifacts
remain listed for download but are never registered.

Register an ISO only on a CloudStack release with the same major.minor as its
marker. Upgrading CloudStack across a format boundary means bumping
`CLOUDSTACK_VERSION`, rebuilding the active matrix under the new marker, and
letting the sync register the rebuilt artifacts and retire the drifted ones.

## CloudStack API Address

The ISOs carry no CloudStack API address. When CKS creates a cluster, it stores
a `cloudstack-secret` Secret in `kube-system` whose `cloud-config` holds an
`api-url` line, taken from the global setting `endpoint.url`, and API keys for
the cluster's account. The cloud controller manager and the CloudStack CSI
driver read that Secret. `endpoint.url` is therefore the one configuration
input that points every new cluster at a given CloudStack installation.

Set it to a CloudStack API URL that cluster nodes and pods can reach:

```bash
cmk update configuration name=endpoint.url \
  value=https://cloudstack.example.com/client/api
```

The setting is global and dynamic, so it applies to the next cluster created
without a management server restart. The URL must meet these conditions:

- Tenant cluster networks can reach it, usually through their source NAT
  address and public DNS. The CloudStack default,
  `http://localhost:8080/client/api`, does not work: CKS refuses to create a
  cluster while the value is blank or names `localhost`. A management-network
  address is normally unreachable from tenant networks, and the controller
  then times out on every `LoadBalancer` Service.
- It uses HTTPS with a certificate valid for its host name, since API requests
  and responses carry the cluster account's data.
- `api.allowed.source.cidr.list` admits the source NAT addresses of the tenant
  networks when `api.source.cidr.checks.enabled` is `true`.

Check the value a cluster received without printing its keys:

```bash
kubectl -n kube-system get secret cloudstack-secret \
  -o jsonpath='{.data.cloud-config}' | base64 -d | grep '^api-url'
```

CKS creates the Secret only when it is absent, so a changed `endpoint.url`
reaches new clusters only. [Existing clusters](#existing-clusters) covers the
update for clusters created earlier.

## Cloud Controller Manager

CKS deploys the CloudStack cloud controller manager, the component that turns a
`LoadBalancer` Service into CloudStack load balancer rules, from the binaries
ISO. The upstream ISO build script bundles `provider.yaml` from the `main`
branch of `apache/cloudstack-kubernetes-provider` together with the image it
names, `apache/cloudstack-kubernetes-provider:v1.2.0`. When a cluster is
created, the control node copies `provider.yaml` to `/opt/provider/` and
CloudStack's `deploy-provider` script applies it, unless a
`cloud-controller-manager` pod already exists. `upgradeKubernetesCluster`
imports the new ISO's images and copies its `provider.yaml`, but does not apply
it, so an upgrade never changes a running cluster's controller.

The v1.2.0 controller calls `listManagementServersMetrics` at start-up. That
API is root-admin only, so for every other account the call fails with error
432 and the controller exits; such clusters get no load balancer addresses
([apache/cloudstack-kubernetes-provider#94](https://github.com/apache/cloudstack-kubernetes-provider/issues/94)).
Upstream commit
[`5147f76`](https://github.com/apache/cloudstack-kubernetes-provider/commit/5147f76478f66191513d8741ffd8800a35684fc2)
replaces the call with `listCapabilities`; no release contains it.

### Choosing the controller in the ISOs

Two build inputs select the controller an ISO deploys. In CI they are set in
`.github/workflows/cks-images.yml`; for a local build, export them before
running `scripts/build-iso.sh`.

- `CCM_IMAGE`: the controller image by digest,
  `<registry>/<repository>@sha256:<digest>`. A tag is refused.
- `CCM_SOURCE_COMMIT`: the full `apache/cloudstack-kubernetes-provider` commit
  the image was built from. The ISO takes `deployment.yaml` from that commit
  and replaces its image line with `CCM_IMAGE`.

When both are empty, ISOs keep the upstream manifest and the v1.2.0 image.
When set, the build refuses to publish an ISO whose `provider.yaml` does not
name `CCM_IMAGE` or that lacks the image archive, and the artifact name carries
the first 12 hex digits of the image digest:

```text
setup-v<k8s>-calico-cs<major.minor>-ccm<digest12>-<arch>-<machine>.iso
```

The ISO build pulls the image anonymously, and nodes run it from the ISO's
image archive (`imagePullPolicy: IfNotPresent`), so the image must be readable
without credentials from the build host.

### Building the controller image

The `CCM image` workflow (`.github/workflows/ccm-image.yml`) builds upstream
commit `5147f76` for `linux/amd64` and `linux/arm64` and publishes it as
`ghcr.io/runatlas-is/cloudstack-kubernetes-provider:<commit>`. The run summary
prints the digest. `CCM_IMAGE` in `.github/workflows/cks-images.yml` holds the
digest the published ISOs use.

To build the same image into another registry, with a buildx builder that
supports multi-platform builds (`docker buildx create --use`):

```bash
git clone https://github.com/apache/cloudstack-kubernetes-provider.git
cd cloudstack-kubernetes-provider
git checkout 5147f76478f66191513d8741ffd8800a35684fc2
docker buildx build --platform linux/amd64,linux/arm64 \
  --provenance=false --sbom=false \
  -t registry.example.com/cloudstack-kubernetes-provider:5147f76 --push .
docker buildx imagetools inspect \
  registry.example.com/cloudstack-kubernetes-provider:5147f76
```

The `Digest` line of the last command gives the value for
`CCM_IMAGE=registry.example.com/cloudstack-kubernetes-provider@sha256:<digest>`.
`--provenance=false --sbom=false` keeps the image index free of attestation
manifests, which `ctr` cannot export into the ISO. The `git describe` output
embedded in the binary needs the full history, so clone without `--depth`.

## Registering Versions

Use one CloudStack supported version per Kubernetes patch version.

- Published ISOs are immutable. A supported version points at one URL and
  checksum, so changing the object behind a registered URL invalidates the
  record.
- New clusters use the newest enabled patch of the chosen minor.
- Existing clusters move to a new patch only through an explicit
  `upgradeKubernetesCluster` call
  ([API reference](https://cloudstack.apache.org/api/apidocs-4.22/apis/upgradeKubernetesCluster.html)).

### Registering one version

Verify the artifact against its signed checksum set, then register it:

```bash
BASE=https://s3.runatlas.is/atlas-static-assets/cks
MINOR=1.34
ISO=setup-v1.34.12-calico-cs4.22-amd64-x86_64.iso

curl -fsSL https://runatlas-is.github.io/cks-images/keys/atlas-cloud-artifact-signing-2026.asc \
  | gpg --import
curl -fsSL -O "$BASE/CHECKSUM-$MINOR" -O "$BASE/CHECKSUM-$MINOR.asc" -O "$BASE/$ISO"
gpg --verify "CHECKSUM-$MINOR.asc" "CHECKSUM-$MINOR"
grep -F "  $ISO" "CHECKSUM-$MINOR" | sha256sum --check -
```

`gpg --verify` must report a good signature with the primary key fingerprint
`4BB5 C9F5 58FB D4A0 981F 07EF 1A2D 98FB 5D03 6FC3`; the signature itself
comes from that key's signing subkey. Then register the URL and checksum with
`addKubernetesSupportedVersion`, or with the helper:

```bash
python3 -m pip install cs
CLOUDSTACK_ENDPOINT=https://cloudstack.example.com/client/api \
python3 scripts/register-cloudstack-version.py \
  --version 1.34.12 \
  --url "$BASE/$ISO" \
  --checksum "$(grep -F "  $ISO" "CHECKSUM-$MINOR" | cut -d' ' -f1)" \
  --zone-id "<zone-id>" \
  --dry-run
```

Remove `--dry-run` once the printed request is correct. The helper reads
`CLOUDSTACK_API_KEY` and `CLOUDSTACK_SECRET_KEY` from the environment; load
them from a secret store rather than typing them on the command line.

### Manifest sync

`scripts/sync-cloudstack-supported-versions.py` pulls the published manifest,
verifies every selected image against the signed `CHECKSUM-<minor>` sets, and
calls the CloudStack API. Run it on a schedule from a host inside the CloudStack
operator network, so CloudStack API credentials never leave that network and
the publisher never writes to CloudStack.

Environment:

- `CLOUDSTACK_ENDPOINT`, `CLOUDSTACK_API_KEY`, `CLOUDSTACK_SECRET_KEY`
- `CLOUDSTACK_ZONE_ID`, or comma-separated `CLOUDSTACK_ZONE_IDS`
- `CKS_MANIFEST_URL`, default
  `https://runatlas-is.github.io/cks-images/manifest.json`
- `CKS_ARCH`, default `x86_64`
- `CKS_MIN_CPU`, default `2`; `CKS_MIN_MEMORY`, default `2048`
- `CKS_DIRECT_DOWNLOAD`, default `false`
- `GPG_SIGNING_FINGERPRINT`: accepted signing keys, comma- or space-separated;
  defaults to the two published keys
- `CKS_ALLOWED_HOSTS`: extra comma-separated host names the script may fetch
  from, for a mirror or another publisher's catalog

```bash
python3 -m venv .cache/cloudstack-venv
.cache/cloudstack-venv/bin/python -m pip install cs

.cache/cloudstack-venv/bin/python scripts/sync-cloudstack-supported-versions.py \
  --latest-per-minor --disable-superseded --disable-eol --fail-on-stalled \
  --dry-run
```

Remove `--dry-run` once the selected versions and zones look correct.
`--minor 1.34` and `--version 1.34.12` narrow a run.

The `CKS images` workflow also has a manual `register_cloudstack` input that
runs the same sync from GitHub Actions after the Pages deploy, through the
`cloudstack-registration` environment. Use it only with an environment-protected
CloudStack account that the publisher is allowed to hold.

### Version lifecycle

Each sync run applies these rules per zone, only to versions whose semantic
version appears in the manifest for the selected architecture:

- **Register**: the newest patch of every in-support minor
  (`--latest-per-minor`) whose manifest artifact is not yet registered. A
  registered entry counts only when it points at the manifest's ISO URL; a
  same-version entry pointing at another artifact is a stale build. The ISO
  downloads through the zone's secondary storage VM and the version becomes
  usable when the ISO reaches `Ready`.
- **Disable drifted**: an entry whose ISO URL differs from the manifest's
  artifact for the same version is disabled once the manifest's own artifact
  is `Ready`, so a rebuild (after a CloudStack format bump or a controller
  change) replaces the stale registration without a gap.
- **Disable superseded** (`--disable-superseded`): once a newer patch of the
  same minor has a `Ready` ISO, older enabled patches of that minor are
  disabled. A registered version the manifest no longer offers is still owned
  by the sync when its ISO URL lives under the manifest's artifact store, and
  retires the same way. Entries pointing anywhere else are operator-registered
  and never touched.
- **Disable EOL** (`--disable-eol`): enabled versions whose Kubernetes minor is
  past its manifest `lifecycle.eol` date are disabled.
- **Stall detection** (`--fail-on-stalled`): a registered version whose ISO is
  still not `Ready` after `--stalled-after-hours` (default 12, env
  `CKS_STALLED_AFTER_HOURS`) makes the run exit non-zero so the scheduler's
  failure alerting fires.
- **Re-enable** (`--enable-existing`, off by default): enables matching
  disabled entries. Without it, the sync never re-enables an entry it
  disabled.

Disabling is non-destructive: running clusters keep working and can still
upgrade to a newer enabled version; only new-cluster creation on the disabled
version is blocked. Deleting versions (`deleteKubernetesSupportedVersion`) and
upgrading clusters stay manual operator actions.

### Minimum CloudStack role

The sync account needs an Admin-type role that allows only:

- `listKubernetesSupportedVersions`
- `addKubernetesSupportedVersion`
- `updateKubernetesSupportedVersion`

Leave out `deleteKubernetesSupportedVersion`, `listZones` (zone IDs come from
configuration), and cluster lifecycle APIs such as `createKubernetesCluster`,
`upgradeKubernetesCluster`, and `deleteKubernetesCluster`. Role rules allow or
deny named APIs and wildcard patterns
([accounts and roles](https://docs.cloudstack.apache.org/en/4.22.0.0/adminguide/accounts.html)).

## Existing Clusters

A cluster keeps the API address and controller it was created with: CKS does
not rewrite an existing `cloudstack-secret`, does not reapply `provider.yaml`
to a cluster that has a controller pod, and upgrades do not apply it. Both
changes below are made in the cluster with its kubeconfig
(`getKubernetesClusterConfig`) and persist across upgrades. Apply them in this
order, since the controller cannot reach CloudStack until the API address is
right; skip the first when the `api-url` line already names a reachable URL.

### API address

Rewrite the `api-url` line in place. The API keys stay in the pipe and are
never printed or passed as arguments:

```bash
NEW_URL='https://cloudstack.example.com/client/api'
K='kubectl -n kube-system'

# The current line is the rollback value.
$K get secret cloudstack-secret -o jsonpath='{.data.cloud-config}' \
  | base64 -d | grep '^api-url'

$K get secret cloudstack-secret -o json \
  | jq --arg url "$NEW_URL" '.data["cloud-config"] |= (@base64d
      | split("\n")
      | map(if test("^api-url *=") then "api-url = " + $url else . end)
      | join("\n") | @base64)' \
  | $K replace -f -
```

Workloads read the Secret at start-up. Restart each one that mounts it: the
controller and, when installed, the CloudStack CSI driver.

```bash
kubectl get deploy,daemonset -A -o json | jq -r '.items[]
  | select(any(.spec.template.spec.volumes[]?; .secret.secretName == "cloudstack-secret"))
  | "\(.metadata.namespace) \(.kind | ascii_downcase)/\(.metadata.name)"' \
  | while read -r ns workload; do
      kubectl -n "$ns" rollout restart "$workload"
    done
```

To roll back, run the same replacement with the recorded URL.

### Controller image

Set the controller to the digest the ISOs use (`CCM_IMAGE`) or to your own
build. Nodes pull the image from its registry when it is not already present,
so they need access to that registry.

```bash
NEW_IMAGE='ghcr.io/runatlas-is/cloudstack-kubernetes-provider@sha256:<digest>'
K='kubectl -n kube-system'

# The current image is the rollback value.
$K get deployment cloud-controller-manager \
  -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'

$K set image deployment/cloud-controller-manager \
  cloud-controller-manager="$NEW_IMAGE"
$K rollout status deployment/cloud-controller-manager --timeout=300s
$K logs deployment/cloud-controller-manager --tail=30
```

The logs must show no error 432 and no API timeout. A `LoadBalancer` Service
then receives an external address within a few minutes:

```bash
kubectl create deployment lb-check --image=registry.k8s.io/e2e-test-images/agnhost:2.53 -- /agnhost netexec --http-port=8080
kubectl expose deployment lb-check --type=LoadBalancer --port=80 --target-port=8080
kubectl get service lb-check --watch
```

Remove the check with `kubectl delete service,deployment lb-check` once it has
an address. To roll back, run the same `set image` with the recorded previous
image.

## Upgrade and Rollback

### Kubernetes patch or minor

Register the new version, then call `upgradeKubernetesCluster` per cluster.
The controller and the API address do not change on upgrade.

### Controller version

Changing `CCM_IMAGE` gives every active Kubernetes patch a new artifact URL,
so the next build rebuilds the whole matrix instead of overwriting ISOs that
CloudStack already registered. The manifest offers one artifact per version:
the one with the current marker, else the unmarked build. The sync then
registers the marked artifacts and disables the earlier registrations once the
replacements are `Ready`.

Setting or changing `CCM_IMAGE` therefore changes what new clusters run in
every zone the sync serves, within one build and one sync run. Prove a new
controller on one minor first: build that minor alone (the workflow's
`k8s_minor` input), register it, create a test cluster, and check a
`LoadBalancer` Service. The next scheduled build rebuilds the remaining minors,
so finish the check, or revert the change, before it runs.

To roll back:

1. Re-enable the earlier entries
   (`updateKubernetesSupportedVersion state=Enabled`), because the sync
   disabled them and does not re-enable an entry without `--enable-existing`.
2. Restore the previous `CCM_IMAGE` and `CCM_SOURCE_COMMIT`. The next build
   publishes a manifest that falls back to the earlier artifacts, and the next
   sync disables the marked entries as drifted.

Clusters created on the marked ISOs keep their controller; patch them back as
in [Controller image](#controller-image) if needed.

### CloudStack

Bump `CLOUDSTACK_VERSION` together with the management server upgrade, never
independently ([CloudStack release contract](#cloudstack-release-contract)).
