import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import { createTopic } from "~/lib/entries.server";
import { entries, nushiAnswers, nushiRequests } from "~/lib/db/schema";
import { personalVillage } from "~/lib/personal-villages.server";
import { setVillageNushi } from "~/lib/nushi-settings.server";
import { processNushiRequest } from "~/lib/nushi.server";
import { loader } from "~/routes/nushi-status";

let h: RouteHarness, requestId: string, topicId: number;
beforeAll(async () => {
  h = await setupRouteHarness();
  vi.stubEnv("VILLAGE_NUSHI", "1"); vi.stubEnv("VILLAGES", "1"); vi.stubEnv("PUBLIC_READING", "1");
  await h.signIn("znushi_status_owner", { homeArea: "en", readLangs: ["en"] });
  await h.signIn("znushi_status_reader", { homeArea: "en", readLangs: ["en"] });
  const village = await personalVillage(h.db, h.ids.znushi_status_owner);
  await setVillageNushi(h.db, h.ids.znushi_status_owner, village!.id, true);
  const topic = await createTopic(h.db, h.ids.znushi_status_owner, { body: "@nushi PRIVATE_QUESTION_MARKER orchard", lang: "en" });
  if (!topic.ok) throw new Error(topic.error);
  topicId = topic.id;
  const [request] = await h.db.select().from(nushiRequests).where(eq(nushiRequests.entryId, topicId));
  requestId = request.id;
});
afterAll(async () => { await h.restore(); vi.unstubAllEnvs(); });
const read = (as?: string, id = requestId) => loader(h.args(h.request(`/nushi/request/${id}/status`, { as }), { id }));

it("returns only state, with no-store, to the caller and public readers", async () => {
  for (const state of ["pending", "processing", "failed", "cancelled"]) {
    await h.db.update(nushiRequests).set({ state, failure: state === "failed" ? "unverified" : null }).where(eq(nushiRequests.id, requestId));
    for (const as of [undefined, "znushi_status_reader", "znushi_status_owner"]) {
      const response = await read(as);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.json()).toEqual({ state });
    }
  }
  await h.db.update(nushiRequests).set({ state: "pending", failure: null }).where(eq(nushiRequests.id, requestId));
});

it("keeps nonpublic pending calls visible only to their caller", async () => {
  await h.db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, topicId));
  try {
    for (const as of [undefined, "znushi_status_reader"]) expect((await h.outcome(() => read(as))).status).toBe(404);
    expect(await (await read("znushi_status_owner")).json()).toEqual({ state: "cancelled" });
  } finally {
    await h.db.update(entries).set({ hiddenAt: null }).where(eq(entries.id, topicId));
    await h.db.update(nushiRequests).set({ state: "pending", failure: null }).where(eq(nushiRequests.id, requestId));
  }
  expect((await h.outcome(() => read(undefined, "unknown"))).status).toBe(404);
});

it("checks completed-answer visibility and never returns its body", async () => {
  await processNushiRequest(h.db, requestId);
  expect(await (await read()).json()).toEqual({ state: "answered" });
  await h.db.update(nushiAnswers).set({ hiddenAt: new Date(), hiddenReason: "moderation" }).where(eq(nushiAnswers.requestId, requestId));
  expect((await h.outcome(() => read())).status).toBe(404);
  expect(await (await read("znushi_status_owner")).json()).toEqual({ state: "answered" });
});

it("does not disclose another caller's state while the feature is disabled", async () => {
  vi.stubEnv("VILLAGE_NUSHI", "");
  try {
    expect((await h.outcome(() => read())).status).toBe(404);
    expect(await (await read("znushi_status_owner")).json()).toEqual({ state: "answered" });
  } finally { vi.stubEnv("VILLAGE_NUSHI", "1"); }
});
