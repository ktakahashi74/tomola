#!/usr/bin/env bash
set -euo pipefail
if (( $# != 1 )) || [[ ! -f $1 ]]; then echo 'Usage: restore-check.sh backup.dump' >&2; exit 2; fi
backup=$1
target="tomola_restore_check_$(date -u +%Y%m%d%H%M%S)_$$"
cleanup() { docker compose exec -T db sh -c 'exec dropdb -U "$POSTGRES_USER" --if-exists --force "$1"' sh "$target"; }
docker compose exec -T db pg_restore --list < "$backup" > /dev/null
docker compose exec -T db sh -c 'exec createdb -U "$POSTGRES_USER" "$1"' sh "$target"
trap cleanup EXIT
docker compose exec -T db sh -c 'exec pg_restore -U "$POSTGRES_USER" -d "$1" --no-owner --no-acl --exit-on-error' sh "$target" < "$backup"
# Use the deployed app's migration code and installed dependencies, with a URL
# derived in-process so credentials never appear in shell arguments or output.
docker compose exec -T -e RESTORE_CHECK_DB="$target" app node --import tsx --input-type=module - <<'JS'
const url = new URL(process.env.DATABASE_URL);
url.pathname = '/' + process.env.RESTORE_CHECK_DB;
process.env.DATABASE_URL = url.href;
const { migrateDatabase } = await import('./app/lib/db/migrate.server.ts');
const { resolveDbConfig } = await import('./app/lib/db/client.server.ts');
await migrateDatabase(resolveDbConfig(), { log: () => {} });
const { default: pg } = await import('pg');
const client = new pg.Client({ connectionString: url.href, connectionTimeoutMillis: 10000, statement_timeout: 10000 });
try {
  await client.connect();
  await client.query('SELECT 1');
  await client.query('SELECT id FROM entries LIMIT 1');
  await client.query('SELECT id FROM jobs LIMIT 1');
  console.log('Restore, migrations and database smoke checks passed.');
} finally { await client.end(); }
JS
