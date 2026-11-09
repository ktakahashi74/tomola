import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { entries, profiles, reports } from "~/lib/db/schema";
import { createTopic } from "~/lib/entries.server";
import { action } from "~/routes/topic";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

let h: RouteHarness;
let id: number;
beforeAll(async () => {
  h = await setupRouteHarness();
  await h.signIn("dispatch_writer");
  await h.signIn("dispatch_reader");
  await h.db.update(profiles).set({ signPosts: false }).where(eq(profiles.userId, h.ids.dispatch_writer));
  const topic = await createTopic(h.db, h.ids.dispatch_writer, { title: "Dispatch", body: "Body", lang: "ja" });
  if (!topic.ok) throw new Error(topic.error);
  id = topic.id;
});
afterAll(() => h.restore());

it("rejects unknown intents without creating a reply", async () => {
  const before = await h.db.select({ id: entries.id }).from(entries);
  const result = await h.outcome(() => action(h.args(h.request(`/t/${id}`, { as: "dispatch_writer", form: { intent: "unknown", body: "Must not publish", lang: "ja" } }), { id: String(id) })));
  expect(result.status).toBe(400);
  expect(await h.db.select({ id: entries.id }).from(entries)).toEqual(before);
});

it.each(["1e0", "0x1", "1.0", " 1 ", "-1", "0"])("rejects noncanonical entry id %s before reporting", async raw => {
  const entryId = raw.replaceAll("1", String(id));
  const before = await h.db.select().from(reports);
  const result = await h.outcome(() => action(h.args(h.request(`/t/${id}`, { as: "dispatch_reader", form: { intent: "flag", entryId, reason: "spam" } }), { id: String(id) })));
  expect(result.status).toBe(404);
  expect(await h.db.select().from(reports)).toEqual(before);
});
