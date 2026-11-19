import { eq } from "drizzle-orm";
import { expect } from "vitest";
import { CREDENTIAL_FRESH_MS } from "~/lib/auth/credential-session.server";
import { session } from "~/lib/db/schema";
import { BASE, type Outcome, type RouteHarness } from "./route-harness";

export async function withStaleSession(h: RouteHarness, handle: string, run: () => Promise<void>) {
  const [current] = await h.db.select({ id: session.id, createdAt: session.createdAt }).from(session).where(eq(session.userId, h.ids[handle]));
  const setCreatedAt = (createdAt: Date) => h.db.update(session).set({ createdAt }).where(eq(session.id, current.id));
  await setCreatedAt(new Date(Date.now() - CREDENTIAL_FRESH_MS - 60_000));
  try { await run(); }
  finally { await setCreatedAt(current.createdAt); }
}

export function expectModerationReauthentication(result: Outcome, next: string) {
  expect(result.status).toBe(303);
  const login = new URL(result.location ?? "", BASE);
  expect(login.origin).toBe(BASE);
  expect(login.pathname).toBe("/login");
  expect(login.searchParams.get("reauth")).toBe("moderation");
  expect(login.searchParams.get("next")).toBe(next);
}
