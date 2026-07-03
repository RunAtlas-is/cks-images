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
  (`--latest-per-minor`) that is not yet registered. The ISO downloads through
  the zone's secondary storage VM and the version becomes usable when the ISO
  reaches `Ready`.
- **Disable superseded** (`--disable-superseded`): once a newer patch of the
  same minor has a `Ready` ISO, older enabled patches of that minor are
  disabled. The replacement being `Ready` is a precondition, so tenant capacity
  never shrinks before its successor is usable.
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
CloudStack API URL used by the CloudStack cloud-controller-manager and related
components. CloudStack's CKS docs call this the global `endpoint.url` setting,
and the URL must be reachable from pods inside the tenant Kubernetes network.

The broken state reported by a tenant is:

```text
http://172.30.0.100:8080/client/api
```

`172.30.0.100` is the internal management VIP and is not routable from a CKS
cluster's auto-created isolated tenant network. LoadBalancer reconciliation
therefore times out when the controller tries to call CloudStack.

For Atlas Cloud, set `endpoint.url` to the public DNS name and HTTPS API path:

```text
https://sky.runatlas.is/client/api
```

The CloudStack API is served on HTTPS port 443. Tenant networks currently need
an internal routing shim for this name: `sky.runatlas.is` resolves publicly to
the `.8` address, while tenant CKS clusters should reach the equivalent `.1`
address from inside the isolated network. Prefer preserving the DNS name for
TLS validation and adding a node-level `/etc/hosts` or equivalent DNS override
that maps `sky.runatlas.is` to the tenant-reachable `.1` address. A bare IP
URL should only be a temporary fallback because it loses the hostname/certificate
contract.

If that path changes, the invariant stays the same: `endpoint.url` must be an
HTTPS CloudStack API URL that CKS nodes and pods can reach, not a management-only
VIP.

After changing `endpoint.url`, newly created clusters should receive the correct
secret automatically. Existing affected clusters need their generated
`cloudstack-secret` redeployed or the cluster recreated. CloudStack maintainers
point to `/opt/bin/deploy-cloudstack-secret` on the control node for redeploying
the generated secret after the URL is fixed:

<https://github.com/apache/cloudstack/discussions/9267>

Validation on an affected cluster:

```bash
kubectl -n kube-system get secret cloudstack-secret -o yaml
kubectl -n kube-system logs -l component=cloud-controller-manager
```

The secret should contain the tenant-routable API URL, and creating a
`Service` of type `LoadBalancer` should list and create CloudStack load
balancer rules without timing out.
