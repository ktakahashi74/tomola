

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { profiles, votes } from "~/lib/db/schema";
import { createTopic } from "~/lib/entries.server";
import { changeHomeArea, getProfile, HOME_AREA_CHANGE_DAYS, nextHomeAreaChangeAt, updatePreferences } from "~/lib/profiles.server";
import { setVote } from "~/lib/votes.server";
import { addMember, createTestDb } from "./helpers/db";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

const DAY = 24 * 60 * 60 * 1000;
const joined = new Date("2026-06-01T00:00:00Z");

// A member who has never changed language area since registration has home_area_changed_at=null.
async function memberJoinedAt(at: Date) {
  const db = await createTestDb();
  await addMember(db, "u1", "hana", { homeArea: "ja", readLangs: ["ja"] });
  await db.update(profiles).set({ createdAt: at }).where(eq(profiles.userId, "u1"));
  return db;
}

describe("changeHomeArea (the first change any time, then once per 90 days)", () => {
  it("lets a new member change the home area right away, whenever after signing up", async () => {
    const db = await createTestDb();
    await addMember(db, "u1", "hana");
    await addMember(db, "u2", "taro");
    const profile = (await getProfile(db, "u1"))!;
    expect(profile.homeAreaChangedAt).toBeNull();
    expect(nextHomeAreaChangeAt(profile)).toBeNull();
    expect(await changeHomeArea(db, "u1", "en")).toEqual({ ok: true, changed: true });
    expect(await getProfile(db, "u1")).toMatchObject({ homeArea: "en", homeAreaChangedAt: expect.any(Date) });
    expect(Math.abs((await getProfile(db, "u1"))!.homeAreaChangedAt!.getTime() - Date.now())).toBeLessThan(60_000);
    // The first change is allowed even long after registration.
    expect(await changeHomeArea(db, "u2", "de", { now: new Date(Date.now() + 500 * DAY) })).toEqual({ ok: true, changed: true });
  });

  it("refuses the second change until 90 days after the first, and says when it becomes possible", async () => {
    const db = await memberJoinedAt(joined);
    const first = new Date(joined.getTime() + 3 * DAY);
    expect(await changeHomeArea(db, "u1", "th", { now: first })).toEqual({ ok: true, changed: true });
    const profile = (await getProfile(db, "u1"))!;
    expect(profile).toMatchObject({ homeArea: "th", homeAreaChangedAt: first });
    const next = new Date(first.getTime() + HOME_AREA_CHANGE_DAYS * DAY);
    expect(HOME_AREA_CHANGE_DAYS).toBe(90);
    expect(nextHomeAreaChangeAt(profile)).toEqual(next);
    expect(await changeHomeArea(db, "u1", "fr", { now: new Date(first.getTime() + 10 * DAY) })).toEqual({ ok: false, error: "too_soon", nextChangeAt: next });
    // Reject through the preceding day.
    expect(await changeHomeArea(db, "u1", "fr", { now: new Date(next.getTime() - 1) })).toEqual({ ok: false, error: "too_soon", nextChangeAt: next });
    expect((await getProfile(db, "u1"))!.homeArea).toBe("th");
    // Allow changes starting exactly 90 days later; a change starts another 90-day period.
    const second = new Date(first.getTime() + 90 * DAY);
    expect(await changeHomeArea(db, "u1", "other", { now: second })).toEqual({ ok: true, changed: true });
    expect(await getProfile(db, "u1")).toMatchObject({ homeArea: "other", homeAreaChangedAt: second });
    expect(await changeHomeArea(db, "u1", "vi", { now: new Date(second.getTime() + 89 * DAY) })).toMatchObject({ ok: false, error: "too_soon" });
  });

  it("does nothing when the same area is chosen: the first change stays available and the clock does not move", async () => {
    const db = await memberJoinedAt(joined);
    const now = new Date(joined.getTime() + 200 * DAY);
    expect(await changeHomeArea(db, "u1", "ja", { now })).toEqual({ ok: true, changed: false });
    expect((await getProfile(db, "u1"))!.homeAreaChangedAt).toBeNull();
    expect(await changeHomeArea(db, "u1", "en", { now })).toEqual({ ok: true, changed: true });
    // Selecting the same area afterward does not move the deadline.
    expect(await changeHomeArea(db, "u1", "en", { now: new Date(now.getTime() + 10 * DAY) })).toEqual({ ok: true, changed: false });
    expect((await getProfile(db, "u1"))!.homeAreaChangedAt).toEqual(now);
    for (const bad of ["xx", "", undefined, 1, "JA"]) expect(await changeHomeArea(db, "u1", bad, { now })).toEqual({ ok: false, error: "invalid_area" });
    expect(await changeHomeArea(db, "ghost", "en", { now })).toEqual({ ok: false, error: "not_found" });
  });

  it("lets exactly one of two concurrent requests change the area; the other is refused with the date", async () => {
    const db = await memberJoinedAt(joined);
    const now = new Date(joined.getTime() + 10 * DAY);
    const results = await Promise.all([changeHomeArea(db, "u1", "en", { now }), changeHomeArea(db, "u1", "th", { now })]);
    expect(results.filter((r) => r.ok && r.changed)).toHaveLength(1);
    const refused = results.filter((r) => !r.ok);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toEqual({ ok: false, error: "too_soon", nextChangeAt: new Date(now.getTime() + 90 * DAY) });
    const winner = results[0].ok ? "en" : "th";
    expect(await getProfile(db, "u1")).toMatchObject({ homeArea: winner, homeAreaChangedAt: now });
  });

  it("does not change the voter_area of votes already given", async () => {
    const db = await memberJoinedAt(joined);
    await addMember(db, "author", "taro", { homeArea: "en", readLangs: ["en"] });
    const topic = await createTopic(db, "author", { lang: "en", title: "t", body: "b" });
    if (!topic.ok) throw new Error("topic failed");
    await setVote(db, "u1", topic.id, true);
    expect(await changeHomeArea(db, "u1", "de", { now: new Date(joined.getTime() + 100 * DAY) })).toMatchObject({ ok: true, changed: true });
    expect((await db.select().from(votes))[0]).toMatchObject({ voterId: "u1", voterArea: "ja" });
  });
});

describe("updatePreferences", () => {
  it("saves the display and read languages (de-duplicated) and validates them", async () => {
    const db = await memberJoinedAt(joined);
    expect(await updatePreferences(db, "u1", { readLangs: ["ja", "en", "en"], displayLang: "en" })).toEqual({ ok: true });
    expect(await getProfile(db, "u1")).toMatchObject({ readLangs: ["ja", "en"], displayLang: "en" });
    expect(await updatePreferences(db, "u1", { readLangs: ["ja"], displayLang: "" })).toEqual({ ok: true });
    expect((await getProfile(db, "u1"))!.displayLang).toBeNull();
    expect(await updatePreferences(db, "u1", { readLangs: [], displayLang: "" })).toEqual({ ok: true });
    expect((await getProfile(db, "u1"))!.readLangs).toEqual([]);
    expect(await updatePreferences(db, "u1", { readLangs: ["xx"], displayLang: "" })).toEqual({ ok: false, error: "invalid_langs" });
    expect(await updatePreferences(db, "u1", { readLangs: ["ja"], displayLang: "xx" })).toEqual({ ok: false, error: "invalid_display_lang" });
    expect(await updatePreferences(db, "ghost", { readLangs: ["ja"], displayLang: "" })).toEqual({ ok: false, error: "not_found" });
    // A failed update changes nothing.
    expect(await getProfile(db, "u1")).toMatchObject({ readLangs: [], displayLang: null });
  });

  it("does not touch the home area or its clock", async () => {
    const db = await memberJoinedAt(joined);
    await updatePreferences(db, "u1", { readLangs: ["en"], displayLang: "en" });
    expect(await getProfile(db, "u1")).toMatchObject({ homeArea: "ja", homeAreaChangedAt: null });
  });
});

describe("/settings (route)", () => {
  let h: RouteHarness;
  beforeAll(async () => {
    h = await setupRouteHarness();
    await h.signIn("hana", { homeArea: "ja", readLangs: ["ja"] });
  });
  afterAll(() => h.restore());

  it("requires a member for both the loader and the action", async () => {
    const route = await import("~/routes/settings");
    expect(await h.outcome(async () => (await route.loader(h.args(h.request("/settings")))))).toMatchObject({ status: 302, location: "/login?next=%2Fsettings" });
    expect(await h.outcome(() => route.action(h.args(h.request("/settings", { form: { intent: "preferences", confirmHomeArea: "1", homeArea: "en" } }))))).toMatchObject({ status: 302, location: "/login" });
    expect((await h.db.select().from(profiles))[0].homeArea).toBe("ja");
  });

  it.each([undefined, "unknown"])("rejects intent %s without changing preferences", async intent => {
    const route = await import("~/routes/settings");
    const before = await getProfile(h.db, h.ids.hana);
    const form = { ...(intent === undefined ? {} : { intent }), displayLang: "en", readLangs: ["en"] };
    const result = await h.outcome(() => route.action(h.args(h.request("/settings", { as: "hana", form }))));
    expect(result.status).toBe(400);
    expect(await getProfile(h.db, h.ids.hana)).toEqual(before);
  });

  it("allows the first change right after signup, then shows the next possible date and refuses with it", async () => {
    const route = await import("~/routes/settings");
    const first = (await route.loader(h.args(h.request("/settings", { as: "hana" })))) as { nextAreaChange: string | null; homeArea: string };
    expect(first).toMatchObject({ homeArea: "ja", nextAreaChange: null });
    const bad = await h.outcome(() => route.action(h.args(h.request("/settings", { as: "hana", form: { intent: "preferences", confirmHomeArea: "1", homeArea: "xx" } }))));
    expect(bad.status).toBe(400);
    const ok = await h.outcome(() => route.action(h.args(h.request("/settings", { as: "hana", form: { intent: "preferences", confirmHomeArea: "1", homeArea: "en" } }))));
    expect(ok).toMatchObject({ status: 302, location: "/settings?saved=preferences#settings-languages" });
    expect((await getProfile(h.db, h.ids.hana))!.homeArea).toBe("en");
    const loaded = (await route.loader(h.args(h.request("/settings", { as: "hana" })))) as { nextAreaChange: string | null };
    const expected = nextHomeAreaChangeAt((await getProfile(h.db, h.ids.hana))!)!.toISOString().slice(0, 10);
    expect(loaded.nextAreaChange).toBe(expected);
    const again = await h.outcome(() => route.action(h.args(h.request("/settings", { as: "hana", form: { intent: "preferences", confirmHomeArea: "1", homeArea: "fr" } }))));
    expect(again.status).toBe(400);
    expect(again.value).toMatchObject({ data: { intent: "preferences", error: "too_soon", date: expected } });
    expect((await getProfile(h.db, h.ids.hana))!.homeArea).toBe("en");
  });

  it("allows another change once 90 days have passed and saves the language preferences", async () => {
    const route = await import("~/routes/settings");
    await h.db.update(profiles).set({ homeAreaChangedAt: new Date(Date.now() - 91 * DAY) }).where(eq(profiles.userId, h.ids.hana));
    const loaded = (await route.loader(h.args(h.request("/settings", { as: "hana" })))) as { nextAreaChange: string | null };
    expect(loaded.nextAreaChange).toBeNull();
    const ok = await h.outcome(() => route.action(h.args(h.request("/settings", { as: "hana", form: { intent: "preferences", confirmHomeArea: "1", homeArea: "de" } }))));
    expect(ok).toMatchObject({ status: 302, location: "/settings?saved=preferences#settings-languages" });
    expect((await getProfile(h.db, h.ids.hana))!.homeArea).toBe("de");

    const form = { intent: "preferences", homeArea: "de", displayLang: "th", readLangs: ["ja", "en"] };
    const res = await h.outcome(() => route.action(h.args(h.request("/settings", { as: "hana", form }))));
    expect(res).toMatchObject({ status: 302, location: "/settings?saved=preferences#settings-languages" });
    expect(await getProfile(h.db, h.ids.hana)).toMatchObject({ displayLang: "th", readLangs: ["ja", "en"], homeArea: "de" });
    const empty = await h.outcome(() => route.action(h.args(h.request("/settings", { as: "hana", form: { intent: "preferences", homeArea: "de", displayLang: "" } }))));
    expect(empty).toMatchObject({ status: 302, location: "/settings?saved=preferences#settings-languages" });
    expect(await getProfile(h.db, h.ids.hana)).toMatchObject({ readLangs: [], displayLang: null, homeArea: "de" });
  });
  it("returns a handle change to its section while retaining the saved feedback", async () => {
    const route = await import("~/routes/settings");
    await h.signIn("settings_owner");
    const result = await h.outcome(() => route.action(h.args(h.request("/settings", {
      as: "settings_owner", form: { intent: "handle", handle: "settings_changed" },
    }))));
    expect(result).toMatchObject({ status: 302, location: "/settings?saved=handle#settings-handle" });
    const loaded = await route.loader(h.args(h.request(result.location!, { as: "settings_owner" })));
    expect(loaded).toMatchObject({ handle: "settings_changed", saved: "handle" });
  });

  it("returns a rejected signing change to its advanced section without changing the preference", async () => {
    const route = await import("~/routes/settings");
    const before = (await getProfile(h.db, h.ids.hana))!.signPosts;
    const result = await h.outcome(() => route.action(h.args(h.request("/settings", {
      as: "hana", form: { intent: "sign-posts", signPosts: "1" },
    }))));
    expect(result).toMatchObject({ status: 403, value: { data: { intent: "sign-posts", error: "signature_required" } } });
    expect((await getProfile(h.db, h.ids.hana))!.signPosts).toBe(before);
  });

});
