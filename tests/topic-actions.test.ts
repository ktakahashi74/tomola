import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { entries, nushiRequests, profiles, reports, villageMembers, villages } from "~/lib/db/schema";
import { createTopic } from "~/lib/entries.server";
import { action } from "~/routes/topic";
import { action as newTopic } from "~/routes/topic-new";
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
afterEach(() => vi.unstubAllEnvs());

it("ignores suppression submitted through topic and reply forms", async () => {
  for (const flag of ["VILLAGES", "PUBLIC_READING", "VILLAGE_NUSHI"]) vi.stubEnv(flag, "1");
  const [village] = await h.db.insert(villages).values({ slug: "form-calls", kind: "open" }).returning();
  await h.db.insert(villageMembers).values({ villageId: village.id, userId: h.ids.dispatch_writer, role: "owner" });
  const posted = await h.outcome(() => newTopic(h.args(h.request("/t/new", { as: "dispatch_writer", form: { body: "@nushi topic source", lang: "en", village: village.slug!, villageExplicit: "1", villageDisplayed: village.slug!, suppressNushi: "1" } }))));
  expect(posted, JSON.stringify(posted.value)).toMatchObject({ status: 302 });
  const [request] = await h.db.select().from(nushiRequests);
  expect(request).toBeDefined();
  const path = `/t/${request.threadId}`;
  const replied = await h.outcome(() => action(h.args(h.request(path, { as: "dispatch_writer", form: { intent: "reply", body: "@nushi explain", lang: "en", suppressNushi: "1" } }), { id: String(request.threadId) })));
  expect(replied.status).toBe(302);
  expect(await h.db.select().from(nushiRequests)).toHaveLength(2);
});

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
