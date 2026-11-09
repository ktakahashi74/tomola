#!/usr/bin/env bash
set -euo pipefail
umask 077

if (( $# > 2 )); then echo 'Usage: backup-db.sh [directory] [retain-count]' >&2; exit 2; fi
directory=${1:-backups}
retain=${2:-7}
if [[ ! $retain =~ ^[1-9][0-9]{0,5}$ ]]; then echo 'retain-count must be a positive integer' >&2; exit 2; fi
mkdir -p -- "$directory"
name="tomola-$(date -u +%Y%m%dT%H%M%S%NZ)-$$.dump"
temporary=$(mktemp "$directory/.backup-XXXXXXXX")
trap 'rm -f -- "$temporary"' EXIT
docker compose exec -T db sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$temporary"
docker compose exec -T db pg_restore --list < "$temporary" > /dev/null
mv -- "$temporary" "$directory/$name"

# Delete only this script's completed dumps, and only after the new dump is verified.
mapfile -t backups < <(find "$directory" -maxdepth 1 -type f -regextype posix-extended \
  -regex '.*/tomola-[0-9]{8}T[0-9]{15}Z-[0-9]+\.dump' ! -name "$name" -printf '%f\n' | LC_ALL=C sort -r)
# Reserve one retained slot for the new dump, even if an older dump's clock
# was ahead of this machine's clock. Other file names never enter retention.
for ((index=retain-1; index<${#backups[@]}; index++)); do rm -- "$directory/${backups[index]}"; done
printf '%s\n' "$directory/$name"
