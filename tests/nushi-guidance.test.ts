import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { createTopic } from "~/lib/entries.server";
import { entries, profiles, villages } from "~/lib/db/schema";
import { createVillage } from "~/lib/village-management.server";
import { acceptChatConsent } from "~/lib/village-chat.server";
import { villageBySlug } from "~/lib/villages.server";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

let h: RouteHarness, topicId: number, villageId: string;
const owner = "guidance_owner", slug = "nushi-guidance";
beforeAll(async () => {
  for (const key of ["VILLAGES", "PUBLIC_READING", "VILLAGE_CHAT", "VILLAGE_NUSHI", "VILLAGE_CHAT_NUSHI"]) vi.stubEnv(key, "1");
  h = await setupRouteHarness();
  await h.signIn(owner, { homeArea: "en", readLangs: ["en"] });
  expect((await createVillage(h.db, h.ids[owner], { slug, name: "Guidance village", kind: "open", description: "" })).ok).toBe(true);
  villageId = (await villageBySlug(h.db, slug))!.id;
  const topic = await createTopic(h.db, h.ids[owner], { body: "Orchard discussion", lang: "en", village: slug });
  if (!topic.ok) throw new Error(topic.error);
  topicId = topic.id;
  await acceptChatConsent(h.db, h.ids[owner], slug);
});
afterEach(async () => {
  vi.stubEnv("VILLAGE_NUSHI", "1"); vi.stubEnv("VILLAGE_CHAT_NUSHI", "1");
  await h.db.update(villages).set({ nushiEnabled: true, endedAt: null, kind: "open" }).where(eq(villages.id, villageId));
  await h.db.update(entries).set({ nushiDisabled: false }).where(eq(entries.id, topicId));
  await h.db.update(profiles).set({ suspendedUntil: null }).where(eq(profiles.userId, h.ids[owner]));
});
afterAll(() => { h.restore(); vi.unstubAllEnvs(); });

it("returns Nushi controls to the topic document after a client-side navigation", async () => {
  const { loader } = await import("~/routes/topic");
  const page = await loader(h.args(h.request(`/t/${topicId}.data?lang=en`, { as: owner }), { id: String(topicId) }));
  expect(page.nushi.controls).toContain(`name="returnTo" value="/t/${topicId}?lang=en"`);
  expect(page.nushi.controls).not.toContain(".data");
});

it.each(["allowed", "off", "village-off", "ended", "topic-off", "suspended", "guest"])("offers reply guidance only to a writer who can call Nushi (%s)", async mode => {
  if (mode === "off") vi.stubEnv("VILLAGE_NUSHI", "");
  if (mode === "village-off") await h.db.update(villages).set({ nushiEnabled: false }).where(eq(villages.id, villageId));
  if (mode === "ended") await h.db.update(villages).set({ endedAt: new Date() }).where(eq(villages.id, villageId));
  if (mode === "topic-off") await h.db.update(entries).set({ nushiDisabled: true }).where(eq(entries.id, topicId));
  if (mode === "suspended") await h.db.update(profiles).set({ suspendedUntil: new Date(Date.now() + 60_000) }).where(eq(profiles.userId, h.ids[owner]));
  const { loader } = await import("~/routes/topic");
  const page = await loader(h.args(h.request(`/t/${topicId}?lang=en`, { as: mode === "guest" ? undefined : owner }), { id: String(topicId) }));
  expect(page.nushiAvailable).toBe(mode === "allowed");
});

it.each(["allowed", "off", "village-off", "ended", "suspended"])("offers chat guidance only to a writer who can call Nushi (%s)", async mode => {
  if (mode === "off") vi.stubEnv("VILLAGE_CHAT_NUSHI", "");
  if (mode === "village-off") await h.db.update(villages).set({ nushiEnabled: false }).where(eq(villages.id, villageId));
  if (mode === "ended") await h.db.update(villages).set({ endedAt: new Date() }).where(eq(villages.id, villageId));
  if (mode === "suspended") await h.db.update(profiles).set({ suspendedUntil: new Date(Date.now() + 60_000) }).where(eq(profiles.userId, h.ids[owner]));
  const { loader } = await import("~/routes/village-chat");
  const page = await loader(h.args(h.request(`/v/${slug}/chat?lang=en`, { as: owner }), { slug }));
  expect("chatNushiAvailable" in page ? page.chatNushiAvailable : false).toBe(mode === "allowed");
});
