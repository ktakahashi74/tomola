import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getSessionProfile, requireMember } from "~/lib/auth/session.server";
import { profiles } from "~/lib/db/schema";
import { displayLangFor, readingLanguageChoice, screenReadLangsFor } from "~/lib/display-lang.server";
import { prepareUiLocale } from "~/lib/http/member-locale.server";
import { getRequestUiLocale, negotiateUiLocale, setRequestUiLocale, shouldSuppressBrowserTranslation } from "~/lib/http/locale.server";
import * as sessions from "~/lib/auth/session.server";
import * as members from "~/lib/members.server";
import { getProfile, rememberUiLocale, setUiLocale } from "~/lib/profiles.server";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import { trialForm } from "./helpers/trial";
import { setTestLocale } from "./stubs/paraglide-runtime";

let h: RouteHarness;
const enabled = ["ja", "en", "fr"] as const;
beforeAll(async () => {
  h = await setupRouteHarness();
  await h.signIn("locale_reader", { homeArea: "ja" });
});
beforeEach(async () => {
  vi.stubEnv("ENABLED_LANGS", enabled.join(","));
  setTestLocale("en");
  await h.db.update(profiles).set({ uiLocale: "ja" }).where(eq(profiles.userId, h.ids.locale_reader));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); setTestLocale("en"); });
afterAll(() => h.restore());

const stored = async () => (await getProfile(h.db, h.ids.locale_reader))!.uiLocale;

describe("saved display language", () => {
  it.each(["", "?lang=fr", "?lang=fr&rl=1", "?lang=en&rl=fr"])("uses the saved language before browser and shared-link languages: %s", async search => {
    const request = h.request(`/settings${search}`, { as: "locale_reader", headers: { "accept-language": "en" } });
    await prepareUiLocale(request);
    expect(negotiateUiLocale(request, enabled, getRequestUiLocale(request))).toEqual({ locale: "ja", source: "profile" });
    expect(shouldSuppressBrowserTranslation(request, enabled)).toBe(true);
    expect(await stored()).toBe("ja");
  });

  it("keeps shared-link reading overrides independent from the saved interface and original-reading preferences", async () => {
    const request = h.request("/t/1?lang=fr", { as: "locale_reader", headers: { "accept-language": "en" } });
    await prepareUiLocale(request);
    setTestLocale("ja");
    const profile = await getSessionProfile(request);
    expect(displayLangFor(request, profile)).toBe("fr");
    expect(screenReadLangsFor(request, profile)).toEqual([]);
    expect(readingLanguageChoice(request, profile)).toMatchObject({ current: "fr", usual: "ja", ui: null });
    expect(displayLangFor(h.request("/t/1"), profile)).toBe("ja");
    expect(displayLangFor(h.request("/t/1"), { ...profile!, displayLang: "en" })).toBe("en");
  });

  it("lets an enabled cookie win without reading the profile during negotiation", async () => {
    const request = h.request("/?lang=fr", { as: "locale_reader" });
    request.headers.append("cookie", "; PARAGLIDE_LOCALE=en");
    const read = vi.spyOn(members, "getActiveMember");
    await prepareUiLocale(request);
    expect(negotiateUiLocale(request, enabled, getRequestUiLocale(request))).toEqual({ locale: "en", source: "cookie" });
    expect(read).not.toHaveBeenCalled();
    expect(await stored()).toBe("ja");
  });

  it("shares a single profile read with concurrent member gates", async () => {
    const request = h.request("/settings", { as: "locale_reader" });
    const read = vi.spyOn(members, "getActiveMember");
    await prepareUiLocale(request);
    const [profile, member] = await Promise.all([getSessionProfile(request), requireMember(request)]);
    expect(member.profile).toBe(profile);
    expect(read).toHaveBeenCalledOnce();
  });

  it("bounds uncached negotiation and performs no SQL for visitors without a session cookie", async () => {
    const statements: string[] = [];
    const session = (h.db as unknown as { session: { logger: { logQuery(query: string): void } } }).session;
    vi.spyOn(session.logger, "logQuery").mockImplementation(query => { statements.push(query); });
    await prepareUiLocale(h.request("/why", { as: "locale_reader" }));
    const selects = statements.filter(query => /^select /i.test(query));
    expect(selects.length).toBeGreaterThanOrEqual(1);
    expect(selects.length).toBeLessThanOrEqual(4);
    console.info(`Uncached member locale negotiation: ${selects.length} SELECTs (${selects.map(query => /from "([^"]+)"/i.exec(query)?.[1] ?? "other").join(", ")})`);
    statements.length = 0;
    await prepareUiLocale(h.request("/why"));
    expect(statements).toEqual([]);
  });

  it.each(["en", "ja"])("uses the saved language without setting a language cookie on login from a %s guest screen", async locale => {
    const token = await h.issueLink("locale_reader@example.com");
    const response = await (await import("~/routes/auth-confirm")).action(h.args(h.request("/auth/confirm", {
      form: { token }, headers: { cookie: h.linkCookie(token), "accept-language": locale },
    }))) as Response;
    expect(response.status).toBe(303);
    expect(response.headers.has("X-Remix-Reload-Document")).toBe(locale !== "ja");
    expect(response.headers.getSetCookie().some(cookie => cookie.startsWith("PARAGLIDE_LOCALE="))).toBe(false);
    expect(await stored()).toBe("ja");
  });

  it.each([false, true])("ignores another account's cached locale when the login target has a profile: %s", async hasProfile => {
    const handle = hasProfile ? "locale_unset" : "locale_new";
    await h.signIn(handle, { profile: hasProfile });
    if (hasProfile) await h.db.update(profiles).set({ uiLocale: null }).where(eq(profiles.userId, h.ids[handle]));
    const token = await h.issueLink(`${handle}@example.com`);
    const request = h.request("/auth/confirm", {
      as: "locale_reader", form: { token }, headers: { "accept-language": "en" },
    });
    request.headers.append("cookie", `; ${h.linkCookie(token)}`);
    await prepareUiLocale(request);
    expect(getRequestUiLocale(request)).toBe("ja");
    const response = await (await import("~/routes/auth-confirm")).action(h.args(request)) as Response;
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(hasProfile ? "/" : "/onboarding");
    expect(response.headers.has("X-Remix-Reload-Document")).toBe(false);
    expect(response.headers.getSetCookie().some(cookie => cookie.startsWith("PARAGLIDE_LOCALE="))).toBe(false);
    expect((await getProfile(h.db, h.ids[handle]))?.uiLocale ?? null).toBe(hasProfile ? "en" : null);
    expect(await stored()).toBe("ja");
  });

  it.each([
    ["?lang=fr", "en", "fr", "query"],
    ["", "en", "en", "accept-language"],
    ["", "de", "en", "default"],
  ])("falls back to guest rules on lookup failure: %s %s", async (search, accept, locale, source) => {
    const request = h.request(`/principles${search}`, { as: "locale_reader", headers: { "accept-language": accept } });
    setRequestUiLocale(request, "ja");
    vi.spyOn(sessions, "getSessionProfile").mockRejectedValueOnce(new Error("private lookup details"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(prepareUiLocale(request)).resolves.toBeUndefined();
    expect(getRequestUiLocale(request)).toBeNull();
    expect(negotiateUiLocale(request, enabled, getRequestUiLocale(request))).toEqual({ locale, source });
    expect(warning).toHaveBeenCalledExactlyOnceWith("Member display language unavailable; using guest language negotiation.");
  });

  it("preserves guest negotiation, including pinned reading marks", async () => {
    for (const [search, cookie, locale, source] of [
      ["?lang=fr", "", "fr", "query"], ["?lang=fr", "PARAGLIDE_LOCALE=ja", "ja", "cookie"],
      ["?lang=fr&rl=1", "", "en", "accept-language"], ["?lang=en&rl=fr", "", "fr", "query"],
    ]) {
      const request = h.request(`/${search}`, { headers: { cookie, "accept-language": "en" } });
      await prepareUiLocale(request);
      expect(negotiateUiLocale(request, enabled, getRequestUiLocale(request))).toEqual({ locale, source });
    }
  });

  it("falls through missing or disabled saved languages without rewriting them", async () => {
    for (const value of [null, "de"]) {
      await h.db.update(profiles).set({ uiLocale: value }).where(eq(profiles.userId, h.ids.locale_reader));
      const request = h.request("/?lang=fr", { as: "locale_reader", headers: { "accept-language": "en" } });
      await prepareUiLocale(request);
      expect(negotiateUiLocale(request, enabled, getRequestUiLocale(request))).toEqual({ locale: "fr", source: "query" });
      expect(await stored()).toBe(value);
    }
  });

  it("initializes a missing preference atomically without overwriting a simultaneous explicit selection", async () => {
    await h.db.update(profiles).set({ uiLocale: null }).where(eq(profiles.userId, h.ids.locale_reader));
    await setUiLocale(h.db, h.ids.locale_reader, "fr");
    await rememberUiLocale(h.db, h.ids.locale_reader, null, "en");
    expect(await stored()).toBe("fr");
  });

  it.each(["en", "fr"])("retains the saved language after login in %s", async locale => {
    const token = await h.issueLink("locale_reader@example.com");
    const response = await (await import("~/routes/auth-confirm")).action(h.args(h.request("/auth/confirm", {
      form: { token }, headers: { cookie: `${h.linkCookie(token)}; PARAGLIDE_LOCALE=${locale}`, "accept-language": locale },
    }))) as Response;
    expect(response.status).toBe(303);
    expect(response.headers.getSetCookie().some(cookie => cookie.startsWith("PARAGLIDE_LOCALE="))).toBe(false);
    expect(await stored()).toBe("ja");
  });
});

describe("explicit display language saves", () => {
  it.each(["member", "guest", "registering"])("saves an enabled cookie and only the current member's account: %s", async who => {
    if (who === "registering") await h.signIn("locale_pending", { profile: false });
    const request = h.request("/settings/locale", { as: who === "member" ? "locale_reader" : who === "registering" ? "locale_pending" : undefined, form: { locale: "fr" } });
    const response = await (await import("~/routes/settings-locale")).action(h.args(request));
    expect(response.status).toBe(204);
    expect(response.headers.get("set-cookie")).toBe("PARAGLIDE_LOCALE=fr; Path=/; Max-Age=34560000; SameSite=Lax");
    expect(await stored()).toBe(who === "member" ? "fr" : "ja");
  });

  it("rejects cross-origin and invalid saves without changing the account", async () => {
    const { action } = await import("~/routes/settings-locale");
    for (const [locale, origin, status] of [["fr", "https://elsewhere.example", 403], ["de", "http://localhost:5173", 400], ["en; invalid", "http://localhost:5173", 400]] as const) {
      const result = await h.outcome(() => action(h.args(h.request("/settings/locale", { as: "locale_reader", form: { locale }, headers: { origin } }))));
      expect(result.status).toBe(status);
      expect(await stored()).toBe("ja");
    }
  });
});

describe("signup display language", () => {
  it.each([["ja", "ja", "en", ""], ["other", "en", "en", ""], ["other", "fr", "fr", "?lang=fr"]])("aligns main language %s with display language %s from screen %s", async (homeArea, expected, screen, search) => {
    setTestLocale(screen as "en" | "fr");
    const handle = `locale_signup_${homeArea}_${screen}`;
    await h.signIn(handle, { profile: false });
    const request = h.request(`/onboarding${search}`, { as: handle, headers: { "accept-language": "en-US" }, form: { handle, homeArea, ...trialForm } });
    let response: Response | undefined;
    try { await (await import("~/routes/onboarding")).action(h.args(request)); }
    catch (error) { if (!(error instanceof Response)) throw error; response = error; }
    expect(response?.status).toBe(302);
    expect(response?.headers.has("X-Remix-Reload-Document")).toBe(expected !== screen);
    const cookies = response!.headers.getSetCookie().filter(cookie => cookie.startsWith("PARAGLIDE_LOCALE="));
    expect(cookies).toEqual(homeArea === "ja" ? [`PARAGLIDE_LOCALE=ja; Path=/; Max-Age=34560000; SameSite=Lax`] : []);
    expect((await getProfile(h.db, h.ids[handle]))?.uiLocale).toBe(expected);
  });
});
