

import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { profiles } from "~/lib/db/schema";
import { AUTO_IMMEDIATE_KINDS, DEFAULT_EMAIL_PREF, effectiveEmailMode, EMAIL_PREFS, NOTIFICATION_KINDS, isInAppOnlyKind } from "~/lib/notifications";
import { getProfile, rememberUiLocale, setEmailPref } from "~/lib/profiles.server";
import { setTestLocale } from "./stubs/paraglide-runtime";
import { addMember, createTestDb } from "./helpers/db";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

// Notification-email preferences in /settings and recipient UI language in profiles.ui_locale.
describe("the email preference", () => {
  it("defaults to auto and accepts auto, immediate, daily and none only", async () => {
    const db = await createTestDb();
    await addMember(db, "u1", "hana");
    expect(DEFAULT_EMAIL_PREF).toBe("auto");
    expect([...EMAIL_PREFS]).toEqual(["auto", "immediate", "daily", "none"]);
    expect((await getProfile(db, "u1"))!.emailPref).toBe("auto");
    expect(await setEmailPref(db, "u1", "immediate")).toEqual({ ok: true });
    expect((await getProfile(db, "u1"))!.emailPref).toBe("immediate");
    expect(await setEmailPref(db, "u1", "auto")).toEqual({ ok: true });
    expect((await getProfile(db, "u1"))!.emailPref).toBe("auto");
    expect(await setEmailPref(db, "u1", "none")).toEqual({ ok: true });
    for (const bad of ["weekly", "", "DAILY", "Auto", undefined, null, 1]) expect(await setEmailPref(db, "u1", bad), String(bad)).toEqual({ ok: false, error: "invalid_pref" });
    expect((await getProfile(db, "u1"))!.emailPref).toBe("none");
    expect(await setEmailPref(db, "nobody", "daily")).toEqual({ ok: false, error: "not_found" });
    // The database CHECK constraint agrees.
    const error = await db.update(profiles).set({ emailPref: "weekly" }).where(eq(profiles.userId, "u1")).then(() => null, (e: { cause?: { constraint?: string } }) => e);
    expect(error?.cause?.constraint).toBe("profiles_email_pref_check");
  });

  it("initializes the display language only when absent", async () => {
    const db = await createTestDb();
    await addMember(db, "u1", "hana");
    expect((await getProfile(db, "u1"))!.uiLocale).toBeNull();
    await rememberUiLocale(db, "u1", null, "ja");
    expect((await getProfile(db, "u1"))!.uiLocale).toBe("ja");
    // Do not write an unchanged value. Use a different stored marker to verify no update occurred; otherwise an updated marker would move.
    await db.update(profiles).set({ uiLocale: "en" }).where(eq(profiles.userId, "u1"));
    await rememberUiLocale(db, "u1", "ja", "ja");
    expect((await getProfile(db, "u1"))!.uiLocale).toBe("en");
  });
});

describe("the routes", () => {
  let h: RouteHarness;
  beforeAll(async () => {
    h = await setupRouteHarness();
    await h.signIn("hana", { homeArea: "ja" });
  });
  afterAll(() => h.restore());
  afterEach(() => { setTestLocale("en"); vi.unstubAllEnvs(); });

  it("/settings shows and saves the email preference", async () => {
    const route = await import("~/routes/settings");
    const loaded = (await route.loader(h.args(h.request("/settings", { as: "hana" })))) as { emailPref: string };
    expect(loaded.emailPref).toBe("auto");
    const ok = await h.outcome(() => route.action(h.args(h.request("/settings", { as: "hana", form: { intent: "email-pref", emailPref: "immediate" } }))));
    expect(ok).toMatchObject({ status: 302, location: "/settings?saved=email#settings-email" });
    expect(((await route.loader(h.args(h.request("/settings?saved=email", { as: "hana" })))) as { emailPref: string; saved: string }).emailPref).toBe("immediate");
    // `auto` is saved like the others
    expect(await h.outcome(() => route.action(h.args(h.request("/settings", { as: "hana", form: { intent: "email-pref", emailPref: "auto" } }))))).toMatchObject({ status: 302, location: "/settings?saved=email#settings-email" });
    expect((await getProfile(h.db, h.ids.hana))!.emailPref).toBe("auto");
    await h.outcome(() => route.action(h.args(h.request("/settings", { as: "hana", form: { intent: "email-pref", emailPref: "immediate" } }))));
    const bad = await h.outcome(() => route.action(h.args(h.request("/settings", { as: "hana", form: { intent: "email-pref", emailPref: "hourly" } }))));
    expect(bad.status).toBe(400);
    expect((await getProfile(h.db, h.ids.hana))!.emailPref).toBe("immediate");
    // An external origin changes nothing.
    const foreign = h.request("/settings", { as: "hana", form: { intent: "email-pref", emailPref: "none" }, headers: { origin: "https://evil.example" } });
    expect(await h.outcome(() => route.action(h.args(foreign)))).toMatchObject({ status: 403 });
    expect((await getProfile(h.db, h.ids.hana))!.emailPref).toBe("immediate");
  });

  it("the member layout initializes a missing language but preserves it on later cookie and browser visits", async () => {
    const { loader } = await import("~/routes/member-layout");
    setTestLocale("ja");
    await h.outcome(async () => (await loader(h.args(h.request("/", { as: "hana", headers: { "accept-language": "ja" } })))));
    expect((await getProfile(h.db, h.ids.hana))!.uiLocale).toBe("ja");
    setTestLocale("en");
    const request = h.request("/?lang=ja", { as: "hana", headers: { "accept-language": "ja" } });
    request.headers.set("cookie", `${request.headers.get("cookie")}; PARAGLIDE_LOCALE=en`);
    await h.outcome(async () => (await loader(h.args(request))));
    expect((await getProfile(h.db, h.ids.hana))!.uiLocale).toBe("ja");
  });

  it.each([null, "ja"])("opening a shared language link leaves the stored UI locale %s unchanged", async (stored) => {
    vi.stubEnv("ENABLED_LANGS", "ja,en,fr");
    const { loader } = await import("~/routes/member-layout");
    await h.db.update(profiles).set({ uiLocale: stored }).where(eq(profiles.userId, h.ids.hana));
    setTestLocale("fr");
    for (const invalidCookie of [undefined, "de"]) {
      const request = h.request("/t/123?lang=fr", { as: "hana", headers: { "accept-language": "en" } });
      if (invalidCookie) request.headers.set("cookie", `${request.headers.get("cookie")}; PARAGLIDE_LOCALE=${invalidCookie}`);
      expect(await h.outcome(async () => (await loader(h.args(request))))).toMatchObject({ status: 200 });
      expect((await getProfile(h.db, h.ids.hana))!.uiLocale).toBe(stored);
    }
  });

  it("preserves the saved preference with disabled queries and unmatched browser languages", async () => {
    vi.stubEnv("ENABLED_LANGS", "ja,en");
    const { loader } = await import("~/routes/member-layout");
    await h.db.update(profiles).set({ uiLocale: "ja" }).where(eq(profiles.userId, h.ids.hana));
    setTestLocale("en");
    await h.outcome(async () => (await loader(h.args(h.request("/?lang=fr", { as: "hana", headers: { "accept-language": "en" } })))));
    expect((await getProfile(h.db, h.ids.hana))!.uiLocale).toBe("ja");
    await h.db.update(profiles).set({ uiLocale: "ja" }).where(eq(profiles.userId, h.ids.hana));
    await h.outcome(async () => (await loader(h.args(h.request("/", { as: "hana", headers: { "accept-language": "de" } })))));
    expect((await getProfile(h.db, h.ids.hana))!.uiLocale).toBe("ja");
  });

  it("logging in with a magic link remembers the language of the confirm page", async () => {
    const { action } = await import("~/routes/auth-confirm");
    await h.db.update(profiles).set({ uiLocale: null }).where(eq(profiles.userId, h.ids.hana));
    setTestLocale("ja");
    const token = await h.issueLink("hana@example.com");
    const res = (await action(h.args(h.request("/auth/confirm", { form: { token }, headers: { cookie: h.linkCookie(token), "accept-language": "ja" } })))) as Response;
    expect(res.status).toBe(303);
    expect((await getProfile(h.db, h.ids.hana))!.uiLocale).toBe("ja");
  });

  it("logging in from a query-language page preserves the stored notification language", async () => {
    vi.stubEnv("ENABLED_LANGS", "ja,en,fr");
    const { action } = await import("~/routes/auth-confirm");
    await h.db.update(profiles).set({ uiLocale: "ja" }).where(eq(profiles.userId, h.ids.hana));
    setTestLocale("fr");
    const token = await h.issueLink("hana@example.com");
    const res = (await action(h.args(h.request("/auth/confirm?lang=fr", { form: { token }, headers: { cookie: h.linkCookie(token), "accept-language": "en" } })))) as Response;
    expect(res.status).toBe(303);
    expect((await getProfile(h.db, h.ids.hana))!.uiLocale).toBe("ja");
  });
});

describe("how a notification is mailed (effectiveEmailMode)", () => {
  it("`auto` mails replies and mentions immediately, other mailed kinds daily, and author language notices never", () => {
    expect([...AUTO_IMMEDIATE_KINDS]).toEqual(["reply_to_topic", "reply_to_reply", "response_to_topic", "mention", "chat_mention", "chat_reply"]);
    const auto = Object.fromEntries(NOTIFICATION_KINDS.map((k) => [k, effectiveEmailMode("auto", k)]));
    expect(auto).toEqual({ reply_to_topic: "immediate", reply_to_reply: "immediate", response_to_topic: "immediate", moderation: "daily", appeal_decided: "daily", followed_thread: "daily", mention: "immediate", chat_mention: "immediate", chat_reply: "immediate", village_invite: "daily", village_added: "daily", village_removed: "daily", village_owner_changed: "daily", translation_report_result: "daily", nushi_result: "daily", nushi_cited: "daily", source_language_mismatch: "none", entry_translation_unavailable: "none" });
  });

  it("preferences override mailed kinds while author language notices stay in-app", () => {
    for (const kind of NOTIFICATION_KINDS) {
      expect(effectiveEmailMode("immediate", kind), kind).toBe(isInAppOnlyKind(kind) ? "none" : "immediate");
      expect(effectiveEmailMode("daily", kind), kind).toBe(isInAppOnlyKind(kind) ? "none" : "daily");
      expect(effectiveEmailMode("none", kind), kind).toBe("none");
    }
  });
});

// The migration follows_notifications: every `daily` becomes `auto` (the old default and a chosen `daily` cannot be told apart); `immediate` and `none` stay; the new default is `auto`.
