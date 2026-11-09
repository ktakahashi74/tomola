-- Data removal (custom migration): stop storing IP addresses and user agents in sessions (advanced.ipAddress.disableIpTracking and the session create.before hook
-- in app/lib/auth/auth.server.ts) to minimize personal data retained in sessions.
-- Erase existing values but retain the columns, which are part of the Better Auth schema.
UPDATE "session" SET "ip_address" = NULL, "user_agent" = NULL WHERE "ip_address" IS NOT NULL OR "user_agent" IS NOT NULL;
