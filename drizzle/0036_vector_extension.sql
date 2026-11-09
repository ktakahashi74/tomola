-- pgvector (semantic search). PGlite loads @electric-sql/pglite-pgvector when opened (app/lib/db/client.server.ts); production PostgreSQL uses an image with pgvector.
-- Stop here without permission to install the extension (superuser or a role allowed to install pgvector as trusted).
CREATE EXTENSION IF NOT EXISTS vector;
