# CKS binary ISO builder

Atlas Cloud's download pipeline for CloudStack Kubernetes Service (CKS)
binary ISOs. Produces the ISOs, signs them, and hosts them at
<https://download.runatlas.is/cks/>.

This tree is deliberately separate from `./ansible/` (which manages the
CloudStack infrastructure itself). The builder is a *tenant* of CloudStack —
a disposable VM plus a bucket — not part of the platform's control plane.

## Layout

```text
cks-builder/
├── README.md                 (this file)
├── ansible/                  provisions the cks-builder VM + bucket + webserver
│   ├── site.yml              main playbook (provisioning + configuration)
│   ├── group_vars/all.yml    tunables (profile, zone, hostnames, etc.)
│   ├── library/              custom modules for CloudStack bucket ops
│   ├── inventory.yml
│   ├── ansible.cfg
│   └── requirements.yml
├── scripts/
│   ├── build-iso.sh          wrap upstream create-kubernetes-binaries-iso.sh
│   ├── bulk-build.sh         loop over many versions, prune between builds
│   └── sign-artifacts.sh     sign every ISO + regenerate per-minor CHECKSUM
├── index/                    Bun project that renders cks/index.html
│   ├── build.ts              `bun run build`  → writes dist/index.html + assets
│   ├── publish.ts            `bun run publish` → uploads dist/* to the bucket
│   ├── package.json
│   ├── bun.lock
│   └── tsconfig.json
└── traefik/                  edge config deployed to the builder VM
    ├── docker-compose.yml.j2
    ├── traefik.yml.j2
    ├── download.yml.j2
    └── branding/             favicon, logo, KEY.asc, bucket-root README
```

The GitHub Actions workflow lives at `.github/workflows/build-cks-iso.yml`
(upstream of this tree because GHA hard-codes that path).

## First-time provisioning

Supply the GPG signing key material via your preferred secret store
(ansible-vault file, env var, `--extra-vars`):

```bash
ansible-playbook --check --diff -e @secrets.yml cks-builder/ansible/site.yml
ansible-playbook --diff         -e @secrets.yml cks-builder/ansible/site.yml
```

`secrets.yml` (or equivalent) provides at minimum:

```yaml
atlas_private_key: |
  -----BEGIN PGP PRIVATE KEY BLOCK-----
  ...
  -----END PGP PRIVATE KEY BLOCK-----
```

The playbook:

1. Creates (or reuses) the CloudStack SSH key, isolated network with egress,
   a public IP with port-forwards, the build VM, and the Ceph RGW bucket.
2. Imports the Atlas signing key into a dedicated keyring on the VM.
3. Installs docker + containerd with a mirror.gcr.io override for
   docker.io, aws-cli v2, and Bun.
4. Ships `cks-builder/scripts/*`, the Bun project under `cks-builder/index/`,
   and the Traefik compose stack with Let's Encrypt HTTP-01.

## Operator runbook on the VM

```bash
ssh ubuntu@<cks-builder-host>
cd /opt/cks-builder
./scripts/bulk-build.sh 1.33.11 1.34.7 1.35.4      # or any subset
./scripts/sign-artifacts.sh                         # refresh .asc + CHECKSUM-<minor>
(cd index && bun run build && bun run publish)     # refresh the explorer page
```

## Explorer

`https://download.runatlas.is/cks/` reads the bucket through the Bun script,
renders an Apache mod_autoindex-style table with Name / Arch / Last modified
/ Size / Maintenance / EOL columns. Kubernetes support dates come from
[endoflife.date](https://endoflife.date/api/kubernetes.json) at render time.
Per-minor `CHECKSUM-<minor>` files are clearsigned with the Atlas artifact
key, with the public key published at
<https://download.runatlas.is/keys/atlas-cloud-artifact-signing.asc>.

## Can we drop the VM and host statically from the bucket?

Not today. Ceph RGW does speak the S3 static-website-hosting API
(`put-bucket-website` + index-document + public-read policy), but two
pieces are missing on this cluster:

- No website endpoint is configured. On AWS, buckets get served at
  `<bucket>.s3-website.<region>.amazonaws.com`; on Ceph RGW the
  equivalent hostname is set by the operator via
  `rgw_dns_s3website_name` in the zonegroup config. Nothing responds on
  the expected variants today.
- No Let's Encrypt certificate is provisioned for a website hostname.
  The current LE cert covers `s3.runatlas.is` (the S3 API endpoint),
  which serves 403 on anonymous reads by design.

Both are platform-team changes, not tenant-side. Until that lands the
Traefik VM keeps earning its keep (TLS termination + a rewrite middleware
so `/cks/` → `cks/index.html`). When it does land, the playbook's
download-server tasks can collapse into a `put-bucket-website` call
plus a DNS change; the build/publish pipeline here is already separable
from the web server.

## Required GitHub Actions secrets

- `ATLAS_S3_ACCESS_KEY_ID`
- `ATLAS_S3_SECRET_ACCESS_KEY`

These are the access key + secret for the `atlas-static-assets` Ceph RGW
bucket; configure them as repository secrets in GitHub.
