import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { listSeen, profiles, user } from "~/lib/db/schema";
import { exchangeListSeen } from "~/lib/list-seen.server";
import { action } from "~/routes/list-seen";
import { addMember, createTestDb } from "./helpers/db";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

let h: RouteHarness;
beforeAll(async () => {
  h = await setupRouteHarness();
  await h.signIn("watermark_reader");
  await h.signIn("watermark_other");
});
afterAll(() => h.restore());
const first = "2026-01-01T00:00:00.000Z";
const second = "2026-01-02T00:00:00.000Z";
const send = (scope: string, seenAt = first, extra: Record<string, string> = {}) => action(h.args(h.request("/list-seen", { as: "watermark_reader", form: { scope, seenAt, ...extra } })));

it("returns the previous account boundary and advances only to a newer time", async () => {
  expect(await (await send("/")).json()).toEqual({ previous: null });
  expect(await (await send("/", second)).json()).toEqual({ previous: first });
  expect(await (await send("/", first)).json()).toEqual({ previous: second });
  const again = await send("/", second);
  expect(again.headers.get("cache-control")).toBe("private, no-store");
  expect(await again.json()).toEqual({ previous: second });
});

it("writes only the session member's row, ignoring submitted account identifiers", async () => {
  await exchangeListSeen(h.db, h.ids.watermark_other, "/a/en", new Date(first));
  await send("/a/en", second, { userId: h.ids.watermark_other, user_id: h.ids.watermark_other });
  const rows = await h.db.select().from(listSeen).where(eq(listSeen.scope, "/a/en"));
  expect(rows.find(row => row.userId === h.ids.watermark_reader)?.seenAt.toISOString()).toBe(second);
  expect(rows.find(row => row.userId === h.ids.watermark_other)?.seenAt.toISOString()).toBe(first);
});

it("clamps future times to the server's current time", async () => {
  const sent = Date.now();
  expect((await send("/a/de", new Date(sent + 86_400_000).toISOString())).status).toBe(200);
  const [row] = await h.db.select().from(listSeen).where(eq(listSeen.scope, "/a/de"));
  expect(row.seenAt.getTime()).toBeLessThanOrEqual(Date.now());
  expect(row.seenAt.getTime()).toBeGreaterThanOrEqual(sent);
});

it("rejects invalid times and paths outside bounded list scopes without changing records", async () => {
  const before = await h.db.select().from(listSeen);
  for (const seenAt of ["invalid", ""]) {
    expect(await h.outcome(() => send("/a/ja", seenAt))).toMatchObject({ status: 400 });
  }
  for (const scope of ["", "/t/1", "/latest.md", "/a/no", "/v/../secret", "/v/a?x=1", "/v/a#x", "https://example.com/", `/v/${"a".repeat(68)}`, "/v/a\n"]) {
    expect(await h.outcome(() => send(scope)), scope).toMatchObject({ status: 400 });
  }
  expect(await h.db.select().from(listSeen)).toEqual(before);
  for (const scope of ["/a/zh-Hant", "/a/zh-Hans/", "/v/list-seen-test", "/v/list-seen-test/"]) {
    expect((await send(scope)).status).toBe(200);
  }
});

it("rejects signed-out, cross-origin and non-POST writes", async () => {
  expect(await h.outcome(() => action(h.args(h.request("/list-seen", { form: { scope: "/", seenAt: first } }))))).toMatchObject({ status: 302, location: "/login" });
  expect(await h.outcome(() => action(h.args(h.request("/list-seen", { as: "watermark_reader", form: { scope: "/", seenAt: first }, headers: { origin: "https://elsewhere.example" } }))))).toMatchObject({ status: 403 });
  expect(await h.outcome(() => action(h.args(h.request("/list-seen", { as: "watermark_reader" }))))).toMatchObject({ status: 405 });
});

it("allows suspended members to update their own private viewing state", async () => {
  await h.db.update(profiles).set({ suspendedUntil: new Date(Date.now() + 86_400_000), suspendedReason: "spam" }).where(eq(profiles.userId, h.ids.watermark_reader));
  try { expect((await send("/a/ja")).status).toBe(200); }
  finally { await h.db.update(profiles).set({ suspendedUntil: null, suspendedReason: null }).where(eq(profiles.userId, h.ids.watermark_reader)); }
});

it("retains the 50 most recently advanced lists per member and cascades account deletion", async () => {
  const db = await createTestDb();
  await addMember(db, "watermark_cap", "watermark_cap");
  await addMember(db, "watermark_kept", "watermark_kept");
  await db.insert(listSeen).values(Array.from({ length: 50 }, (_, index) => ({ userId: "watermark_cap", scope: `/v/list-${index}`, seenAt: new Date(first), updatedAt: new Date(Date.UTC(2025, 0, 1, 0, 0, index)) })));
  await exchangeListSeen(db, "watermark_kept", "/", new Date(first));
  await exchangeListSeen(db, "watermark_cap", "/v/list-0", new Date(second));
  await exchangeListSeen(db, "watermark_cap", "/", new Date(second));
  const rows = await db.select().from(listSeen).where(eq(listSeen.userId, "watermark_cap"));
  expect(rows).toHaveLength(50);
  expect(rows.map(row => row.scope)).toContain("/v/list-0");
  expect(rows.map(row => row.scope)).not.toContain("/v/list-1");
  expect(await db.select().from(listSeen).where(and(eq(listSeen.userId, "watermark_kept"), eq(listSeen.scope, "/")))).toHaveLength(1);
  await db.delete(user).where(eq(user.id, "watermark_cap"));
  expect(await db.select().from(listSeen)).toMatchObject([{ userId: "watermark_kept" }]);
});
