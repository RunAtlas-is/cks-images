# CloudStack Integration

This repository builds and publishes CKS binaries ISOs. CloudStack must still
know which ISO URLs are supported for tenant Kubernetes clusters.

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
- Older patch versions can stay enabled while tenants are using them. Disable an
  old patch only after deciding that no new clusters should be created on it.
- Do not use `force_rebuild` for a patch version that is already registered in
  CloudStack unless the old object is intentionally revoked and the registration
  is repaired manually.

CloudStack supports upgrading a running CloudManaged Kubernetes cluster by
passing the target supported-version ID to `upgradeKubernetesCluster`:

<https://cloudstack.apache.org/api/apidocs-4.22/apis/upgradeKubernetesCluster.html>

## Manual Registration

The scheduled GitHub workflow publishes ISOs and the static catalog only. Use
this helper manually, or wrap it in your own automation, after an ISO exists in
object storage. Set these environment variables:

- `CLOUDSTACK_ENDPOINT`
- `CLOUDSTACK_API_KEY`
- `CLOUDSTACK_SECRET_KEY`
- `CLOUDSTACK_ZONE_ID`

Optional environment variables:

- `CKS_MIN_CPU`, default `2`
- `CKS_MIN_MEMORY`, default `2048`

Example:

```bash
python3 scripts/register-cloudstack-version.py \
  --version 1.33.11 \
  --url "https://s3.runatlas.is/atlas-static-assets/cks/<iso>" \
  --checksum <sha256> \
  --zone-id "${CLOUDSTACK_ZONE_ID}" \
  --enable-existing
```

The CloudStack API role behind this account must allow:

- `listKubernetesSupportedVersions`
- `addKubernetesSupportedVersion`
- `updateKubernetesSupportedVersion`

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
`Service` of type `LoadBalancer` should no longer time out while listing or
creating CloudStack load balancer rules.
