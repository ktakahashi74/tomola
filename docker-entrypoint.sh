#!/bin/sh
# Docker entrypoint: validate configuration and generated language counts before migrations, then start the server.
# Run scripts/migrate.ts directly with tsx, the same script as pnpm db:migrate in package.json. Do not use corepack or pnpm at runtime:
# code is read-only, and startup must not fail because corepack tries to write its cache or access the network. The image excludes .env; compose supplies variables through env_file.
# The migration script takes a PostgreSQL advisory lock, so two app instances can start safely: the second waits for the first to finish.
# On failure (a migration error, pgvector permissions, etc.), do not start the server; the container exits. See "8. Database" in docs/deploy.md.
set -e
./node_modules/.bin/tsx scripts/check-startup.ts
./node_modules/.bin/tsx scripts/migrate.ts
# Configuration validation above permits only empty or 1, with surrounding whitespace.
if [ -n "$(printf '%s' "${VILLAGES:-}" | tr -d '[:space:]')" ]; then
  ./node_modules/.bin/tsx scripts/check-villages.ts
fi
# exec makes the server PID 1 so it receives docker stop's SIGTERM directly (graceful shutdown in server.ts).
exec node server.ts
