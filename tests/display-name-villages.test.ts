import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { updateDisplayNames } from "~/lib/display-names.server";
import { createTopic } from "~/lib/entries.server";
import { getProfile } from "~/lib/profiles.server";
import { followedMemberNavigation, setMemberFollow } from "~/lib/member-follows.server";
import { topicContinuation } from "~/lib/topic-continuation.server";
import { postingVillages } from "~/lib/villages.server";
import { buildListMarkdown } from "~/lib/md/lists.server";
import { postingVillageName, villageName } from "~/lib/village-name";
import { m } from "~/paraglide/messages.js";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import { setTestLocale } from "./stubs/paraglide-runtime";
import { setTestMessages } from "./stubs/paraglide-messages";
import { jsonMessages } from "./helpers/messages-json";

let h: RouteHarness, topicId: number;
beforeAll(async () => {
  setTestMessages(jsonMessages());
  vi.stubEnv("VILLAGES", "1"); vi.stubEnv("ENABLED_LANGS", "ja,en");
  h = await setupRouteHarness();
  await h.signIn("dn_place_owner", { homeArea: "ja" });
  await h.signIn("dn_place_reader", { homeArea: "en" });
  const created = await createTopic(h.db, h.ids.dn_place_owner, { title: "Owned place", body: "表示名のビレッジ", lang: "ja" });
  if (!created.ok) throw Error(created.error); topicId = created.id;
  await setMemberFollow(h.db, h.ids.dn_place_reader, h.ids.dn_place_owner, true);
});
afterAll(() => { h.restore(); vi.unstubAllEnvs(); setTestMessages(); });

it("localizes followed member names and the article's personal village name", async () => {
  await updateDisplayNames(h.db, h.ids.dn_place_owner, "光の書き手", "Light Writer");
  const reader = { displayLang: "en" as const, readLangs: ["en" as const] };
  for (const locale of ["ja", "en"] as const) {
    setTestLocale(locale);
    const name = locale === "ja" ? "光の書き手" : "Light Writer";
    const navigation = await followedMemberNavigation(h.db, h.ids.dn_place_reader, locale);
    expect(navigation[0]).toMatchObject({ name, handle: "dn_place_owner" });
    expect((await topicContinuation(h.db, topicId, reader))?.village).toMatchObject({ name, slug: "@dn_place_owner" });
    // General labels stay generic; posting labels identify the current owner.
    const own = (await postingVillages(h.db, h.ids.dn_place_owner, undefined, { reader, repair: false })).choices.find(village => village.kind === "personal")!;
    expect(villageName(own)).toBe(m.village_personal());
    expect(postingVillageName(own, "dn_place_owner")).toBe(m.village_personal_destination({ handle: "dn_place_owner" }));
  }
});

it("uses either remaining form, then the handle when both forms are empty", async () => {
  const reader = { displayLang: "en" as const, readLangs: [] };
  for (const [native, latin, expected] of [["名前のみ", "", "名前のみ"], ["", "Latin Only", "Latin Only"], ["", "", "@dn_place_owner"]]) {
    await updateDisplayNames(h.db, h.ids.dn_place_owner, native, latin);
    for (const locale of ["ja", "en"] as const) {
      setTestLocale(locale);
      const member = (await followedMemberNavigation(h.db, h.ids.dn_place_reader, locale))[0];
      expect(member.name ?? `@${member.handle}`).toBe(expected);
      expect((await topicContinuation(h.db, topicId, reader))?.village.name).toBe(expected);
    }
  }
});

it("keeps personal villages out of the machine-readable followed-post list", async () => {
  await updateDisplayNames(h.db, h.ids.dn_place_owner, "光の書き手", "Light Writer");
  const profile = await getProfile(h.db, h.ids.dn_place_reader);
  for (const locale of ["ja", "en"] as const) {
    setTestLocale(locale);
    const markdown = await buildListMarkdown(h.db, profile, { kind: "following" }, { page: 1, lang: locale, k: null });
    expect(markdown).not.toContain("@dn_place_owner");
    expect(markdown).not.toContain("display_name:");
  }
});
