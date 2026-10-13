#!/usr/bin/env bash
# Fail unless key file $1 holds exactly the primary key with fingerprint $2 and
# that key carries a revocation signature. A retired signing key stays
# published only in its revoked form, so a consumer who refreshes it learns the
# key is revoked instead of trusting new signatures made with it.
set -euo pipefail

key_file="${1:?usage: check-revoked-key.sh <key file> <fingerprint>}"
expected="${2:?usage: check-revoked-key.sh <key file> <fingerprint>}"
expected="${expected//[[:space:]]/}"
expected="${expected^^}"

home=$(mktemp -d)
trap 'rm -rf "$home"' EXIT
chmod 700 "$home"

listing=$(gpg --batch --homedir "$home" --with-colons \
  --import-options show-only --import "$key_file" 2>/dev/null) || true

mapfile -t primaries < <(awk -F: '
  $1 == "pub" { want = 1; validity = $2; next }
  $1 == "fpr" && want { print toupper($10) ":" validity; want = 0 }
  $1 == "sub" || $1 == "uid" { want = 0 }
' <<<"$listing")

if [[ ${#primaries[@]} -ne 1 || "${primaries[0]%%:*}" != "$expected" ]]; then
  echo "!! ${key_file} must hold exactly the key ${expected}; found: ${primaries[*]:-none}" >&2
  exit 1
fi
if [[ "${primaries[0]##*:}" != r ]]; then
  echo "!! ${key_file} holds ${expected} without a revocation signature" >&2
  exit 1
fi
echo "${key_file}: ${expected} is revoked"
