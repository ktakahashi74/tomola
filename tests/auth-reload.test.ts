import { expect, it, vi } from "vitest";
import { createTestDb } from "./helpers/db";

it("keeps authentication configuration available to transaction handlers after module reload", async () => {
  const db = await createTestDb();
  const { createAuth } = await import("~/lib/auth/auth.server");
  const sent: string[] = [];
  const auth = createAuth(db, {
    baseURL: "http://localhost:5173",
    secret: "test-secret-0123456789abcdef0123456789abcdef",
    sendMagicLink: async ({ email }) => { sent.push(email); },
  });
  await auth.$context;
  // The process-wide auth singleton survives a development server module reload.
  vi.resetModules();
  const { bindAuthToDatabase } = await import("~/lib/auth/auth.server");
  await db.transaction(async transaction => {
    const bound = bindAuthToDatabase(auth, transaction);
    await expect(bound.api.signInMagicLink({ body: { email: "member@example.com" }, headers: new Headers() })).resolves.toEqual({ status: true });
  });
  expect(sent).toEqual(["member@example.com"]);
});
