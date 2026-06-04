# CKS binary ISO builder

Atlas Cloud's download pipeline for CloudStack Kubernetes Service (CKS) binary
ISOs — builds, signs, and hosts them at <https://download.runatlas.is/cks/>.

Deliberately separate from `../ansible/` (which manages the CloudStack
infrastructure itself). The builder is a *tenant* of CloudStack — a disposable
VM plus a bucket — not part of the platform's control plane.

## Layout

```text
cks-builder/
├── README.md                 (overview)
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

Provisioning, the operator runbook, the explorer page, and the required CI
secrets: [docs/cks-iso-builder.md](../docs/cks-iso-builder.md).
