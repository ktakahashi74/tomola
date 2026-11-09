import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { profiles, villageMembers, villages } from "~/lib/db/schema";
import { action, loader } from "~/routes/settings";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
let h: RouteHarness, index = 0;
beforeAll(async () => { h = await setupRouteHarness(); });
afterAll(() => h.restore()); afterEach(() => vi.unstubAllEnvs());
async function world() {
  vi.stubEnv("VILLAGES", "1");
  const name = `language_form_${++index}`; await h.signIn(name, { homeArea: "ja" });
  const [village] = await h.db.insert(villages).values({ slug: `language-form-${index}`, kind: "open" }).returning();
  await h.db.insert(villageMembers).values({ villageId: village.id, userId: h.ids[name] });
  const form = { intent: "preferences", homeArea: "ja", displayLang: "en", readLangs: ["ja"], village: village.slug! };
  const send = (extra = {}) => h.outcome(() => action(h.args(h.request("/settings", { as: name, form: { ...form, ...extra } }))));
  return { name, village, send, profile: async () => (await h.db.select().from(profiles).where(eq(profiles.userId, h.ids[name])))[0] };
}
it("saves language preferences and the default destination together without consuming a main-language change", async () => {
  const w = await world(); expect(await w.send()).toMatchObject({ status: 302, location: "/settings?saved=preferences#settings-languages" });
  expect(await w.profile()).toMatchObject({ homeArea: "ja", homeAreaChangedAt: null, displayLang: "en", defaultVillageId: w.village.id });
});
it("asks for confirmation only when the main language changes and saves nothing before approval", async () => {
  const w = await world(), before = await w.profile();
  expect(await w.send({ homeArea: "en" })).toMatchObject({ status: 400, value: { data: { error: "confirm_area", values: { homeArea: "en", displayLang: "en", village: w.village.slug } } } });
  expect(await w.profile()).toEqual(before);
  expect(await w.send({ homeArea: "en", confirmHomeArea: "1" })).toMatchObject({ status: 302 });
  const changed = await w.profile(); expect(changed).toMatchObject({ homeArea: "en", homeAreaChangedAt: expect.any(Date), defaultVillageId: w.village.id });
  expect(await w.send({ homeArea: "en", displayLang: "fr" })).toMatchObject({ status: 302 });
  expect((await w.profile())!.homeAreaChangedAt).toEqual(changed!.homeAreaChangedAt);
});
it("keeps unrelated language settings editable during the main-language cooldown", async () => {
  const w = await world(); await h.db.update(profiles).set({ homeAreaChangedAt: new Date() }).where(eq(profiles.userId, h.ids[w.name]));
  expect(await w.send()).toMatchObject({ status: 302 });
  const before = await w.profile();
  expect(await w.send({ homeArea: "en", confirmHomeArea: "1", displayLang: "fr" })).toMatchObject({ status: 400, value: { data: { error: "too_soon" } } });
  expect(await w.profile()).toEqual(before);
});
it.each([{ displayLang: "bad" }, { village: "not-joined" }, { homeArea: "bad", confirmHomeArea: "1" }])("rejects an invalid combined change atomically: %j", async extra => {
  const w = await world(), before = await w.profile();
  expect((await w.send(extra)).status).toBe(400); expect(await w.profile()).toEqual(before);
});
it("saves preferences while villages are disabled without querying destination tables", async () => {
  const w = await world(), before = await w.profile(); vi.stubEnv("VILLAGES", "");
  expect(await w.send({ village: "not-joined" })).toMatchObject({ status: 302 });
  expect(await w.profile()).toMatchObject({ displayLang: "en", defaultVillageId: before!.defaultVillageId });
});

it("allows a suspended member to keep the destination while refusing a changed one atomically", async () => {
  const w = await world();
  await h.db.update(profiles).set({ defaultVillageId: w.village.id, suspendedUntil: new Date(Date.now() + 86_400_000) }).where(eq(profiles.userId, h.ids[w.name]));
  expect(await w.send()).toMatchObject({ status: 302, location: "/settings?saved=preferences#settings-languages" });
  const before = await w.profile();
  const [other] = await h.db.insert(villages).values({ slug: "language-form-other", kind: "open" }).returning();
  await h.db.insert(villageMembers).values({ villageId: other.id, userId: h.ids[w.name] });
  expect(await w.send({ village: other.slug, displayLang: "fr" })).toMatchObject({ status: 302, location: "/suspended" });
  expect(await w.profile()).toEqual(before);
});

it("saves every language preference after leaving all villages without choosing a destination", async () => {
  const w = await world();
  await h.db.delete(villageMembers).where(eq(villageMembers.userId, h.ids[w.name]));
  await h.db.update(profiles).set({ defaultVillageId: null }).where(eq(profiles.userId, h.ids[w.name]));
  expect(await w.send({ village: "", homeArea: "en", confirmHomeArea: "1", displayLang: "fr", readLangs: [] })).toMatchObject({ status: 302 });
  expect(await w.profile()).toMatchObject({ defaultVillageId: null, homeArea: "en", displayLang: "fr", readLangs: [] });
});

it.each([false, true])("keeps an unset default when saving its rendered personal choice, suspended=%s", async suspended => {
  const w = await world();
  await h.db.update(profiles).set({ defaultVillageId: null, suspendedUntil: suspended ? new Date(Date.now() + 86_400_000) : null }).where(eq(profiles.userId, h.ids[w.name]));
  const screen = await loader(h.args(h.request("/settings", { as: w.name }))) as { posting: { selected: string } };
  expect(screen.posting.selected).toBe(`@${w.name}`);
  expect(await w.send({ village: screen.posting.selected, displayLang: "fr", readLangs: [] })).toMatchObject({ status: 302, location: "/settings?saved=preferences#settings-languages" });
  expect(await w.profile()).toMatchObject({ defaultVillageId: null, displayLang: "fr", readLangs: [] });
});

it.each(["ended", "unset"])("keeps an %s default when saving languages with an empty destination", async state => {
  const w = await world();
  const [ended] = await h.db.insert(villages).values({ slug: `ended-default-${index}`, kind: "open", endedAt: new Date() }).returning();
  const defaultVillageId = state === "ended" ? ended.id : null;
  await h.db.update(profiles).set({ defaultVillageId }).where(eq(profiles.userId, h.ids[w.name]));
  const before = await loader(h.args(h.request("/settings", { as: w.name }))) as { posting: { choices: unknown[]; selected: string; error: string | null } };
  expect(before.posting.choices.length).toBeGreaterThan(0);
  expect(before.posting.error).toBe(state === "ended" ? "village_required" : null);
  expect(await w.send({ village: "", displayLang: "fr" })).toMatchObject({ status: 302 });
  expect(await w.profile()).toMatchObject({ defaultVillageId, displayLang: "fr", homeAreaChangedAt: null });
});

it.each([
  ["readLangs", { readLangs: ["en", "fr"] }, { readLangs: ["en", "fr"] }],
  ["displayLang", { displayLang: "fr" }, { displayLang: "fr" }],
  ["village", {}, {}],
])("autosaves only %s even with unrelated changed fields in the request", async (field, input, expected) => {
  const w = await world(), before = await w.profile();
  const response = await w.send({ field, autosave: "1", homeArea: "en", confirmHomeArea: "1", ...input });
  expect(response.status).toBe(200);
  expect(await (response.value as Response).json()).toMatchObject({ ok: true });
  const after = await w.profile();
  expect(after).toEqual({ ...before, ...expected, ...(field === "village" ? { defaultVillageId: w.village.id } : {}) });
});

it("saves only the explicitly confirmed main language", async () => {
  const w = await world(), before = await w.profile();
  expect(await w.send({ field: "homeArea", homeArea: "en" })).toMatchObject({ status: 400, value: { data: { error: "confirm_area" } } });
  expect(await w.profile()).toEqual(before);
  expect(await w.send({ field: "homeArea", homeArea: "en", confirmHomeArea: "1" })).toMatchObject({ status: 302 });
  expect(await w.profile()).toEqual({ ...before, homeArea: "en", homeAreaChangedAt: expect.any(Date) });
});

it("keeps simultaneous field saves independent under the profile lock", async () => {
  const w = await world(), before = await w.profile();
  const results = await Promise.all([
    w.send({ field: "readLangs", autosave: "1", readLangs: ["fr"] }),
    w.send({ field: "displayLang", autosave: "1", displayLang: "en" }),
  ]);
  expect(results.map(result => result.status)).toEqual([200, 200]);
  expect(await w.profile()).toEqual({ ...before, readLangs: ["fr"], displayLang: "en" });
});

it("preserves disabled language preferences when another field is saved", async () => {
  const w = await world();
  await h.db.update(profiles).set({ displayLang: "de", readLangs: ["ja", "de"] }).where(eq(profiles.userId, h.ids[w.name]));
  vi.stubEnv("ENABLED_LANGS", "ja,en");
  expect(await w.send({ field: "readLangs", autosave: "1", readLangs: ["en"] })).toMatchObject({ status: 200 });
  expect(await w.profile()).toMatchObject({ displayLang: "de", readLangs: ["en", "de"] });
  expect(await w.send({ field: "displayLang", autosave: "1", displayLang: "ja" })).toMatchObject({ status: 200 });
  expect(await w.profile()).toMatchObject({ displayLang: "ja", readLangs: ["en", "de"] });
});

it.each([
  { field: "readLangs", readLangs: ["bad"] },
  { field: "displayLang", displayLang: "bad" },
  { field: "village", village: "not-joined" },
  { field: "village", village: "" },
  { field: "unknown" },
  { field: "homeArea", homeArea: "en", confirmHomeArea: "1" },
])("rejects invalid autosaves without writing anything: %j", async input => {
  const w = await world(), before = await w.profile();
  expect((await w.send({ autosave: "1", ...input })).status).toBe(400);
  expect(await w.profile()).toEqual(before);
});

it("retains the writer gate for autosaved destination changes", async () => {
  const w = await world();
  await h.db.update(profiles).set({ suspendedUntil: new Date(Date.now() + 86_400_000) }).where(eq(profiles.userId, h.ids[w.name]));
  const before = await w.profile();
  expect(await w.send({ field: "village", autosave: "1" })).toMatchObject({ status: 302, location: "/suspended" });
  expect(await w.profile()).toEqual(before);
});

it("autosaves mail frequency alone and rejects cross-origin autosaves", async () => {
  const w = await world(), before = await w.profile();
  const send = (emailPref: string, headers = {}) => h.outcome(() => action(h.args(h.request("/settings", { as: w.name, headers, form: { intent: "email-pref", autosave: "1", emailPref, homeArea: "en" } }))));
  const result = await send("daily");
  expect(result.status).toBe(200);
  expect(await (result.value as Response).json()).toEqual({ ok: true, value: "daily" });
  expect(await w.profile()).toEqual({ ...before, emailPref: "daily" });
  expect((await send("bad")).status).toBe(400);
  expect((await send("none", { origin: "https://outside.example" })).status).toBe(403);
  expect(await w.profile()).toEqual({ ...before, emailPref: "daily" });
});

it("limits the JSON endpoint to autosave fields and keeps authentication and CSRF gates", async () => {
  const { action: save } = await import("~/routes/settings-save");
  const w = await world(), before = await w.profile();
  const send = (form: Record<string, string | string[]>, as: string | undefined = w.name, headers = {}) => h.outcome(() => save(h.args(h.request("/settings/save", { as, form, headers }))));
  expect((await send({ intent: "preferences", autosave: "1", field: "displayLang", displayLang: "fr" })).status).toBe(200);
  expect(await w.profile()).toEqual({ ...before, displayLang: "fr" });
  for (const form of [
    { intent: "preferences", autosave: "1", field: "homeArea", homeArea: "en", confirmHomeArea: "1" },
    { intent: "email-pref", emailPref: "none" },
    { intent: "revoke-ai-links", autosave: "1" },
  ] as Record<string, string | string[]>[]) expect((await send(form)).status).toBe(400);
  expect((await send({ intent: "email-pref", autosave: "1", emailPref: "none" }, "", {})).status).toBe(302);
  expect((await send({ intent: "email-pref", autosave: "1", emailPref: "none" }, w.name, { origin: "https://outside.example" })).status).toBe(403);
  expect(await w.profile()).toEqual({ ...before, displayLang: "fr" });
});
