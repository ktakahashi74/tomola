import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTopic } from "~/lib/entries.server";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

// The redirect after posting a reply preserves ?lang=, the display language for that page only.
describe("after posting a reply", () => {
  let h: RouteHarness;
  let topicId: number;
  beforeAll(async () => {
    h = await setupRouteHarness();
    await h.signIn("hana", { homeArea: "ja", readLangs: ["ja", "en"] });
    const t = await createTopic(h.db, h.ids.hana, { lang: "ja", title: "題", body: "本文" });
    if (!t.ok) throw new Error("topic failed");
    topicId = t.id;
  });
  afterAll(() => h.restore());

  const reply = async (query: string) =>
    h.outcome(async () => (await import("~/routes/topic")).action(await h.signedArgs(h.request(`/t/${topicId}${query}`, { as: "hana", form: { body: "返信", lang: "ja", aiAssistance: "none" } }), { id: String(topicId) })));

  it("keeps ?lang= in the redirect, and drops an unknown value", async () => {
    expect((await reply("?lang=en")).location).toMatch(new RegExp(`^/t/${topicId}\\?lang=en&posted=(\\d+)#c-\\1$`));
    expect((await reply("?lang=th&orig=1")).location).toMatch(new RegExp(`^/t/${topicId}\\?lang=th&posted=(\\d+)#c-\\1$`));
    expect((await reply("?lang=xx")).location).toMatch(new RegExp(`^/t/${topicId}\\?posted=(\\d+)#c-\\1$`));
    expect((await reply("")).location).toMatch(new RegExp(`^/t/${topicId}\\?posted=(\\d+)#c-\\1$`));
  });
});
