import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { closeDb, openDb, type Db } from "~/lib/db/client.server";
import { createInvitation, findValidInvitationByToken } from "~/lib/invitations.server";
import { createScratchDb } from "./helpers/pg-real";

// Integration tests against real PostgreSQL; run only when TEST_DATABASE_URL (postgres://) is set.
// Apply migrations to a disposable database so earlier branch schemas cannot affect the test.
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("PostgreSQL (TEST_DATABASE_URL)", { tags: ["postgres"] }, () => {
  it("migrates, creates an invitation and reads it back", async () => {
    const scratch = await createScratchDb({ migrate: false });
    let db: Db | undefined;
    const email = `pg-test-${randomUUID()}@example.com`;
    try {
      db = await openDb({ kind: "pg", url: scratch.url }, { migrate: true });
      const now = new Date("2026-10-01T00:00:00Z");
      const created = await createInvitation(db, { email, now });
      const found = await findValidInvitationByToken(db, created.token, now);
      expect(found?.email).toBe(email);
      // timestamptz returns the same instant regardless of the connection timezone.
      expect(found?.createdAt.toISOString()).toBe(now.toISOString());
      expect(found?.expiresAt.toISOString()).toBe(created.expiresAt.toISOString());
    } finally {
      if (db) await closeDb(db);
      await scratch.drop();
    }
  });
});
