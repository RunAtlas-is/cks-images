# Operations

This guide covers the publishing pipeline: the daily build, the controller
image, artifact storage, signing, and the catalog. It applies to this
repository and to a fork that publishes its own catalog.

## Running the Pipeline

The `CKS images` workflow reads its target from repository configuration and
refuses to run while a required value is missing. Apart from the signing keys,
nothing in the workflow names a publisher, so a fork sets its own values,
replaces the keys, and publishes an independent catalog.

Repository secrets:

| Secret | Purpose |
| --- | --- |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | object storage publish identity ([Artifact storage](#artifact-storage)) |
| `GPG_PRIVATE_KEY_B64_2026` | base64 of the armored private signing key |
| `GPG_PASSPHRASE` | passphrase of that key, when it has one |
| `SLACK_BOT_TOKEN` | optional; failure notifications |

Repository variables:

| Variable | Required | Purpose |
| --- | --- | --- |
| `S3_BUCKET` | yes | bucket holding the artifacts |
| `S3_ENDPOINT_URL` | yes | S3 API endpoint of that bucket |
| `ARTIFACT_BASE_URL` | yes | public URL of the bucket, without the prefix |
| `SITE_BASE_URL` | yes | public URL of the GitHub Pages catalog |
| `GPG_SIGNING_KEY` | yes | user ID or fingerprint of the signing key |
| `GPG_SIGNING_FINGERPRINT_2026` | yes, for a fork | fingerprint that signs new artifacts |
| `GPG_TRUSTED_FINGERPRINTS` | yes, for a fork | every fingerprint whose existing signatures still verify |
| `S3_PREFIX` | no, default `cks/` | key prefix of the artifacts |
| `DOCS_URL` | no | documentation link in the catalog; defaults to this repository's integration guide |
| `CLOUDSTACK_VERSION` | no, default `4.22.1.0` | CloudStack release the ISOs target |
| `CNI_VERSION`, `CRICTL_VERSION`, `CNI_YAML_URL`, `DASHBOARD_YAML_URL` | no | bundled component versions |
| `SLACK_CHANNEL_ID` | no | Slack channel for failure notifications; unset disables them |

The two fingerprint variables default to the keys committed under `keys/`. A
fork replaces those key files and the key paths in the `sign` job and in
`index/build.ts`, and sets both variables. Consumers of a fork's catalog pass
its fingerprints to the sync through `GPG_SIGNING_FINGERPRINT` and its hosts
through `CKS_ALLOWED_HOSTS`
([Manifest sync](cloudstack-integration.md#manifest-sync)).

The cloud controller manager the ISOs ship is fixed in the workflow file
(`CCM_IMAGE`, `CCM_SOURCE_COMMIT`), not in a variable, so changing it is a
reviewed commit ([Cloud controller manager](cloudstack-integration.md#cloud-controller-manager)).

## Daily Build

The `CKS images` workflow runs every day at 06:00 UTC and can also be started
manually from GitHub Actions. It:

1. Resolves the four newest Kubernetes minors that endoflife.date lists as
   supported.
2. Builds the latest stable patch ISO for each minor when the object does not
   exist yet.
3. Uploads ISOs, SHA-256 files, and detached signatures to object storage.
4. Regenerates the signed `CHECKSUM-<minor>` sets.
5. Builds the static catalog and `manifest.json` from the bucket listing and
   deploys both to GitHub Pages.

Manual inputs:

- `k8s_minor`: restrict the matrix to one minor, for example `1.34`.
- `force_rebuild`: rebuild the object even if it already exists.
- `register_cloudstack`: run the CloudStack sync after the Pages deploy
  ([Manifest sync](cloudstack-integration.md#manifest-sync)).

Use `force_rebuild` only for an unpublished or explicitly revoked object. A CKS
ISO that CloudStack has registered is immutable, because the supported version
points at its URL and checksum.

A failed run posts to `SLACK_CHANNEL_ID` with `SLACK_BOT_TOKEN`; leaving the
variable unset disables the notification.

## Cloud Controller Manager Image

The `CCM image` workflow builds `apache/cloudstack-kubernetes-provider` at the
commit pinned in `.github/workflows/ccm-image.yml` for `linux/amd64` and
`linux/arm64`, and publishes it to
`ghcr.io/runatlas-is/cloudstack-kubernetes-provider:<commit>`. Pull requests
that change the workflow build without publishing; a push to `main` or a manual
run publishes and prints the image digest in the run summary.

The tag moves with each publish, and every publish yields a new digest. ISO
builds use the digest set in `CCM_IMAGE`, so publishing alone changes no ISO.

The ISO build and the nodes pull the image without credentials, so the GHCR
package must be public. GitHub sets package visibility only in the package
settings page (Danger Zone, Change visibility); a package does not inherit
visibility from its repository.

## Artifact Storage

GitHub stores the source, workflows, and static catalog. ISO artifacts live in
S3-compatible object storage, because each ISO is about 1 GB.

Grant the publish identity only these object-store actions:

- `s3:ListBucket` on the bucket, constrained to the configured prefix.
- `s3:GetObject` on objects under the configured prefix for existence checks,
  checksum refresh, and catalog generation.
- `s3:PutObject` on objects under the configured prefix for ISOs, SHA-256
  files, signatures, and per-minor checksum sets.
- `s3:PutObject` on objects under `keys/` for the mirrored public signing keys
  and key transition statement.
- `s3:AbortMultipartUpload`, `s3:ListMultipartUploadParts`, and
  `s3:ListBucketMultipartUploads` for multipart ISO uploads.

The publish identity needs no object deletion, bucket policy, ACL, lifecycle,
or bucket administration permission.

Object layout under `<ARTIFACT_BASE_URL>/<S3_PREFIX>`:

- `setup-v<k8s>-calico-cs<major.minor>[-ccm<digest12>]-<arch>-<machine>.iso`
- the same name with `.sha256` and `.asc`
- `CHECKSUM-<minor>` and `CHECKSUM-<minor>.asc`

The catalog and `manifest.json` are generated from the bucket listing and are
not written back to object storage.

## Signing

Every ISO gets a detached GPG signature, and `scripts/sign-artifacts.sh`
regenerates one signed checksum set per Kubernetes minor.

The bucket prefix is shared storage, so presence in the bucket is not treated
as provenance. The sign step only signs and lists an ISO when its digest is
established by the current run's build manifest (emitted by the build job), by
an entry in an already-published `CHECKSUM-<minor>` whose signature verifies
against a trusted fingerprint, or by an existing `.asc` on the ISO that
verifies against a trusted key. Any other ISO object under the prefix is
skipped, excluded from the checksum sets, and fails the run so the object can
be investigated and removed. When running the script outside CI, pass
`BUILT_DIGESTS_FILE` (lines of `sha256  filename`) for ISOs that are not yet
covered by a signed checksum set.

## Artifact Signing Keys

The published catalog uses two keys. Both carry the user ID
`Atlas Cloud (Artifact Signing) <artifacts@runatlas.is>`.

| Fingerprint | File | State |
| --- | --- | --- |
| `4BB5C9F558FBD4A0981F07EF1A2D98FB5D036FC3` | `keys/atlas-cloud-artifact-signing-2026.asc` | current; signs new artifacts, expires 2028-09-12 |
| `4C2D72FDDEF77A5CC4A7D2C421CA4588DCB6991E` | `keys/atlas-cloud-artifact-signing.asc` | valid for artifacts signed before 2026-09-13 |

The current key is an ed25519 primary key that certifies only, with an ed25519
signing subkey. `gpg --verify` reports the subkey fingerprint first and the
primary fingerprint last, and the pipeline accepts a pin in either position.

The previous key certifies the current key, so a consumer who already trusts
the previous key can confirm the new one from the key material alone. The
transition statement at `keys/atlas-artifact-signing-key-transition-2026.txt.asc`
names both fingerprints and is signed by both keys:

```bash
gpg --import keys/atlas-cloud-artifact-signing.asc \
             keys/atlas-cloud-artifact-signing-2026.asc
gpg --verify keys/atlas-artifact-signing-key-transition-2026.txt.asc
```

Signing uses the current key alone, pinned by `SIGNING_FINGERPRINT`
(repository variable `GPG_SIGNING_FINGERPRINT_2026`). Verification accepts any
key in `TRUSTED_FINGERPRINTS` (repository variable
`GPG_TRUSTED_FINGERPRINTS`), which carries both fingerprints, so ISO
signatures and checksum sets written before the rotation stay valid and are
never re-signed. The CloudStack sync pins the same pair through
`GPG_SIGNING_FINGERPRINT`, which accepts a comma- or space-separated list, and
refuses a keyring holding any key outside it.

Both public keys and the transition statement are committed under `keys/`,
included in the GitHub Pages artifact, and copied to object storage under the
same names by the sign job.

Retiring the previous key is a separate change: it drops the previous
fingerprint from `TRUSTED_FINGERPRINTS` and from the CloudStack pin, removes
the key file from `keys/` and from object storage, and publishes a revocation
certificate. Every artifact signed with the previous key must be re-signed with
the current key before that change lands, because its signature stops
verifying.

## Local Builds

Local builds use the same script as CI
([Building the images](../README.md#building-the-images)). To upload from a
local run, also set the target and load the credentials from a secret store:

```bash
export S3_BUCKET=<bucket>
export S3_ENDPOINT_URL=https://s3.example.com
export S3_PREFIX=cks/
# AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY from the secret store
./scripts/build-iso.sh
```

To refresh signatures and checksum sets for existing bucket objects:

```bash
export AWS_ENDPOINT_URL=https://s3.example.com
export BUCKET_NAME=<bucket>
export S3_PREFIX=cks/
export SIGNING_KEY=<signing key user ID or fingerprint>
# AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY from the secret store
./scripts/sign-artifacts.sh
```
