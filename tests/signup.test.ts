import { operatorCopy } from "~/lib/operator-settings";
import { testOperator } from "./helpers/operator";
import { messageText } from "~/lib/i18n/messages";
import { trialForm } from "./helpers/trial";
import fs from "node:fs";
import { createElement, type ReactNode } from "react";
import { renderInRouter } from "./helpers/render-in-router";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { drafts, user } from "~/lib/db/schema";
import { createDraft } from "~/lib/drafts.server";
import { createReply, createTopic } from "~/lib/entries.server";
import { createProfile, defaultPostLang, defaultReadLangs, getProfile, updatePreferences, changeHomeArea } from "~/lib/profiles.server";
import { HOME_AREA_CHANGE_DAYS } from "~/lib/profile-settings";
import { LANG_LABELS, LANGS, type Lang } from "~/lib/languages";
import { setTestLocale } from "./stubs/paraglide-runtime";
import { addMember, createTestDb } from "./helpers/db";
import { setupRouteHarness } from "./helpers/route-harness";
import { m } from "~/paraglide/messages.js";
import { messageMarkup } from "./helpers/message-markup";

// Signup eligibility, consent and language settings; the post language is chosen per post.
vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));
// Render portal choices inline for server markup assertions; browser tests exercise the real portal.
vi.mock("~/components/ui/select", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/components/ui/select")>();
  return { ...actual, SelectContent: ({ children }: { children: ReactNode }) => createElement("div", { role: "listbox" }, children) };
});
afterEach(() => {
  vi.unstubAllEnvs();
  setTestLocale("en");
});

function selectField(html: string, name: string) {
  const native = new RegExp(`<select\\b[^>]*name="${name}"[^>]*>[\\s\\S]*?<\\/select>`).exec(html);
  if (native) return native[0];
  return [...html.matchAll(/<label[^>]*>[\s\S]*?<\/label>/g)].find(([field]) => field.includes(`name="${name}"`))![0];
}

function optionLabels(field: string) {
  if (field.startsWith("<select")) return [...field.matchAll(/<option[^>]*>([\s\S]*?)<\/option>/g)].map(([, text]) => text);
  return [...field.matchAll(/<div[^>]*role="option"[^>]*>([\s\S]*?)<\/div>/g)].map(([, contents]) => contents.replace(/<[^>]+>/g, ""));
}

async function newUser(db: Awaited<ReturnType<typeof createTestDb>>, id: string) {
  await db.insert(user).values({ id, name: "", email: `${id}@example.com`, emailVerified: true });
}

describe("createProfile: a handle and the main language are enough", () => {
  it("creates a profile from the two fields; the read languages default to the main language only; there is no write_langs column", async () => {
    const db = await createTestDb();
    await newUser(db, "u1");
    const res = await createProfile(db, "u1", { handle: "hana", homeArea: "ja" });
    expect(res).toMatchObject({ ok: true, profile: { handle: "hana", homeArea: "ja", readLangs: ["ja"], displayLang: null } });
    expect(res.ok && "writeLangs" in res.profile).toBe(false);
    const columns = await db.execute(sql`select column_name from information_schema.columns where table_name = 'profiles'`);
    const names = (columns as unknown as { rows: Array<{ column_name: string }> }).rows.map((r) => r.column_name);
    expect(names).toContain("read_langs");
    expect(names).not.toContain("write_langs");
  });

  it("drops a writeLangs that an old caller still sends, and keeps explicit readLangs (tests, seed data)", async () => {
    const db = await createTestDb();
    await newUser(db, "u1");
    const res = await createProfile(db, "u1", { handle: "hana", homeArea: "ja", readLangs: ["ja", "en", "ja"], writeLangs: ["en"] });
    expect(res).toMatchObject({ ok: true, profile: { readLangs: ["ja", "en"] } });
  });

  it("defaults the read languages of an \"other\" member to the language of the signup screen, if enabled, otherwise the default language", async () => {
    vi.stubEnv("ENABLED_LANGS", "ja,en");
    const db = await createTestDb();
    await newUser(db, "u1");
    await newUser(db, "u2");
    await newUser(db, "u3");
    expect(await createProfile(db, "u1", { handle: "one", homeArea: "other" }, { uiLocale: "ja" })).toMatchObject({ ok: true, profile: { homeArea: "other", readLangs: ["ja"] } });
    // a screen language that is not enabled falls back to en
    expect(await createProfile(db, "u2", { handle: "two", homeArea: "other" }, { uiLocale: "de" })).toMatchObject({ ok: true, profile: { readLangs: ["en"] } });
    expect(await createProfile(db, "u3", { handle: "three", homeArea: "other" })).toMatchObject({ ok: true, profile: { readLangs: ["en"] } });
    expect(defaultReadLangs("fr")).toEqual(["fr"]);
    expect(defaultReadLangs("other", "ja")).toEqual(["ja"]);
  });

  it("accepts only an enabled language or \"other\" as the main language (invalid_area), and enabled languages as read languages (invalid_langs)", async () => {
    vi.stubEnv("ENABLED_LANGS", "ja,en");
    const db = await createTestDb();
    await newUser(db, "u1");
    expect(await createProfile(db, "u1", { handle: "hana", homeArea: "de" })).toEqual({ ok: false, error: "invalid_area" });
    expect(await createProfile(db, "u1", { handle: "hana", homeArea: "xx" })).toEqual({ ok: false, error: "invalid_area" });
    expect(await createProfile(db, "u1", { handle: "hana", homeArea: "ja", readLangs: ["ja", "de"] })).toEqual({ ok: false, error: "invalid_langs" });
    expect(await getProfile(db, "u1")).toBeNull();
    expect(await createProfile(db, "u1", { handle: "hana", homeArea: "other" })).toMatchObject({ ok: true });
  });

  it("changeHomeArea accepts the same values; the 90-day rule is unchanged", async () => {
    const db = await createTestDb();
    await addMember(db, "u1", "hana");
    vi.stubEnv("ENABLED_LANGS", "ja,en");
    expect(await changeHomeArea(db, "u1", "de")).toEqual({ ok: false, error: "invalid_area" });
    expect(await changeHomeArea(db, "u1", "other")).toEqual({ ok: true, changed: true });
    // the second change inside 90 days is refused as before
    const second = await changeHomeArea(db, "u1", "en");
    expect(second).toMatchObject({ ok: false, error: "too_soon" });
  });
});

describe("read languages in the settings", () => {
  it("accepts enabled languages only, and keeps the languages that are not enabled any more (closing a language does not erase the setting)", async () => {
    const db = await createTestDb();
    await addMember(db, "u1", "hana", { readLangs: ["ja", "th"] });
    vi.stubEnv("ENABLED_LANGS", "ja,en");
    expect(await updatePreferences(db, "u1", { readLangs: ["en"], displayLang: "" })).toEqual({ ok: true });
    // th is not enabled: the saved value stays after the new selection
    expect((await getProfile(db, "u1"))!.readLangs).toEqual(["en", "th"]);
    expect(await updatePreferences(db, "u1", { readLangs: ["en", "fr"], displayLang: "" })).toEqual({ ok: false, error: "invalid_langs" });
    expect(await updatePreferences(db, "u1", { readLangs: ["ja"], displayLang: "th" })).toEqual({ ok: false, error: "invalid_display_lang" });
    expect(await updatePreferences(db, "u1", { readLangs: ["ja"], displayLang: "en" })).toEqual({ ok: true });
    expect(await getProfile(db, "u1")).toMatchObject({ readLangs: ["ja", "th"], displayLang: "en" });
  });

  it("a language added in the settings is shown as an original (a post in it is not translated by default)", async () => {
    const { wantsTranslation } = await import("~/lib/display");
    const profile = { readLangs: ["ja", "en"], displayLang: "ja" };
    expect(wantsTranslation("en", profile.readLangs, "ja")).toBe(false);
    expect(wantsTranslation("fr", profile.readLangs, "ja")).toBe(true);
  });
});

describe("the language of a post: the main language by default, chosen per post from the enabled languages", () => {
  it("defaultPostLang: the main language if enabled; for \"other\" or a language that is not enabled, the first enabled language the member reads, then the default", () => {
    const enabled: readonly Lang[] = ["ja", "en", "fr"];
    expect(defaultPostLang({ homeArea: "fr", readLangs: ["fr"] }, enabled)).toBe("fr");
    expect(defaultPostLang({ homeArea: "other", readLangs: ["de", "en"] }, enabled)).toBe("en");
    expect(defaultPostLang({ homeArea: "de", readLangs: ["de", "ja"] }, enabled)).toBe("ja");
    expect(defaultPostLang({ homeArea: "other", readLangs: ["de"] }, enabled)).toBe("en");
    expect(defaultPostLang({ homeArea: "other", readLangs: ["de"] }, ["ja", "fr"])).toBe("ja");
    vi.stubEnv("ENABLED_LANGS", "ja,en");
    expect(defaultPostLang({ homeArea: "ja", readLangs: ["ja"] })).toBe("ja");
  });

  it("a member whose main language is English can post in Japanese; the post language is checked against the enabled languages", async () => {
    vi.stubEnv("ENABLED_LANGS", "ja,en");
    const db = await createTestDb();
    await addMember(db, "u1", "kim", { homeArea: "en", readLangs: ["en"] });
    const ja = await createTopic(db, "u1", { lang: "ja", title: "日本語の題", body: "日本語の本文。" });
    expect(ja.ok).toBe(true);
    expect(await createTopic(db, "u1", { lang: "de", title: "t", body: "b" })).toEqual({ ok: false, error: "invalid_lang" });
    if (!ja.ok) throw new Error("topic failed");
    expect(await createReply(db, "u1", ja.id, { lang: "de", body: "b" })).toEqual({ ok: false, error: "invalid_lang" });
    expect(await createReply(db, "u1", ja.id, { lang: "en", body: "ok" })).toMatchObject({ ok: true });
  });

  it("drafts: a language that is not enabled cannot be saved, and publishing a draft saved before the language was closed fails with invalid_lang and keeps the draft", async () => {
    const db = await createTestDb();
    await addMember(db, "u1", "kim", { homeArea: "en", readLangs: ["en"] });
    // saved while all nine languages were enabled
    const made = await createDraft(db, "u1", { kind: "topic", lang: "de", title: "Titel", body: "Text." });
    if (!made.ok) throw new Error("draft failed");
    vi.stubEnv("ENABLED_LANGS", "ja,en");
    expect(await createDraft(db, "u1", { kind: "topic", lang: "de", title: "Titel", body: "Text." })).toEqual({ ok: false, error: "invalid_lang" });
    const { publishDraft } = await import("~/lib/drafts.server");
    expect(await publishDraft(db, "u1", made.id)).toEqual({ ok: false, error: "invalid_lang" });
    expect(await db.select().from(drafts).where(eq(drafts.id, made.id))).toHaveLength(1);
  });

  it("the API draft takes the main language as the default and refuses a language that is not enabled with 400 invalid_lang, naming the enabled languages", async () => {
    vi.stubEnv("ENABLED_LANGS", "ja,en");
    const h = await setupRouteHarness();
    try {
      await h.signIn("hana", { homeArea: "en", readLangs: ["en", "ja"] });
      const { createApiToken } = await import("~/lib/tokens.server");
      const token = await createApiToken(h.db, h.ids.hana, { name: "claude code", kind: "draft" });
      if (!token.ok) throw new Error("token failed");
      const { action } = await import("~/routes/api.drafts");
      const post = (text: string) =>
        h.outcome(() => action(h.args(new Request("http://localhost:5173/api/drafts", { method: "POST", headers: { authorization: `Bearer ${token.token}`, "content-type": "text/markdown; charset=utf-8" }, body: text }))));
      const ok = await post("---\ntype: post\ntitle: Hello\n---\nA body.");
      expect(ok).toMatchObject({ status: 201 });
      const [draft] = await h.db.select({ lang: drafts.lang }).from(drafts);
      expect(draft.lang).toBe("en");
      const bad = (await action(h.args(new Request("http://localhost:5173/api/drafts", { method: "POST", headers: { authorization: `Bearer ${token.token}`, "content-type": "text/markdown; charset=utf-8" }, body: "---\ntype: post\ntitle: Hallo\nlang: de\n---\nText." })))) as Response;
      expect(bad.status).toBe(400);
      const body = (await bad.json()) as { error: string; message: string };
      expect(body.error).toBe("invalid_lang");
      expect(body.message).toContain("ja, en");
    } finally {
      h.restore();
    }
  });
});

describe("/onboarding", () => {
  async function signedInWithoutProfile(h: Awaited<ReturnType<typeof setupRouteHarness>>, handle: string) {
    await h.signIn(handle, { profile: false });
  }
  const loaderData = async (h: Awaited<ReturnType<typeof setupRouteHarness>>, as: string, acceptLanguage?: string) => {
    const route = await import("~/routes/onboarding");
    return (await route.loader(h.args(h.request("/onboarding", { as, headers: acceptLanguage === undefined ? {} : { "accept-language": acceptLanguage } })))) as { defaultMainLang: string };
  };

  it("defaults the main language to the language the browser prefers most, if enabled; otherwise \"other\"", async () => {
    const h = await setupRouteHarness();
    try {
      await signedInWithoutProfile(h, "newbie");
      vi.stubEnv("ENABLED_LANGS", "ja,en,fr,zh-Hant,zh-Hans");
      const table: Array<[string | undefined, string]> = [
        ["ja-JP", "ja"],
        ["en-US,fr;q=0.5", "en"],
        // the most preferred language (de) is not enabled: other, although the second one (en) is enabled
        ["de,en;q=0.8", "other"],
        ["zh-TW", "zh-Hant"],
        ["zh-CN", "zh-Hans"],
        ["sv-SE", "other"],
        ["", "other"],
        [undefined, "other"],
      ];
      for (const [header, expected] of table) expect((await loaderData(h, "newbie", header)).defaultMainLang, String(header)).toBe(expected);
      // with Traditional Chinese not enabled, a zh-TW browser is "other"
      vi.stubEnv("ENABLED_LANGS", "ja,en,zh-Hans");
      expect((await loaderData(h, "newbie", "zh-TW")).defaultMainLang).toBe("other");
    } finally {
      h.restore();
    }
  });

  it("creates a profile with eligibility and agreement; reading languages start with the main language", async () => {
    const h = await setupRouteHarness();
    try {
      await signedInWithoutProfile(h, "newbie");
      vi.stubEnv("ENABLED_LANGS", "ja,en");
      const route = await import("~/routes/onboarding");
      const res = await h.outcome(() => route.action(h.args(h.request("/onboarding", { as: "newbie", form: { ...trialForm, handle: "newbie", homeArea: "en" } }))));
      expect(res).toMatchObject({ status: 302, location: "/" });
      expect(await getProfile(h.db, h.ids.newbie)).toMatchObject({ handle: "newbie", homeArea: "en", readLangs: ["en"] });
    } finally {
      h.restore();
    }
  });

  it("uses the language of the screen as the read language of a member who chose \"other\", and refuses a language that is not enabled", async () => {
    const h = await setupRouteHarness();
    try {
      await signedInWithoutProfile(h, "ota");
      await signedInWithoutProfile(h, "bad");
      vi.stubEnv("ENABLED_LANGS", "ja,en");
      const route = await import("~/routes/onboarding");
      setTestLocale("ja");
      const other = await h.outcome(() => route.action(h.args(h.request("/onboarding", { as: "ota", form: { ...trialForm, handle: "ota", homeArea: "other" } }))));
      expect(other).toMatchObject({ status: 302 });
      expect(await getProfile(h.db, h.ids.ota)).toMatchObject({ homeArea: "other", readLangs: ["ja"] });
      const bad = await h.outcome(() => route.action(h.args(h.request("/onboarding", { as: "bad", form: { ...trialForm, handle: "bad", homeArea: "de" } }))));
      expect(bad.value).toMatchObject({ error: "invalid_area" });
      expect(await getProfile(h.db, h.ids.bad)).toBeNull();
    } finally {
      h.restore();
    }
  });

  // the screen, rendered on the server with the real messages
  async function render(path: "onboarding" | "settings", enabled: readonly Lang[], props: Record<string, unknown>, locale: "ja" | "en") {
    setTestLocale(locale);
    const mod = path === "onboarding" ? await import("~/routes/onboarding") : await import("~/routes/settings");
    return renderInRouter(() => createElement(mod.default as never, { loaderData: { opening: {}, existing: false, countries: [], trialRequired: false, notices: { privacy: false, terms: false }, ...props }, actionData: undefined, params: {}, matches: [] } as never), "/", undefined, { enabledLangs: enabled });
  }

  it("shows identity and language choices in both trial publication states and retains the purpose and privacy wording", async () => {
    for (const locale of ["ja", "en"] as const) for (const trialRequired of [false, true]) {
      const html = await render("onboarding", ["ja", "en"], { defaultMainLang: "ja", trialRequired, notices: { privacy: trialRequired, terms: trialRequired } }, locale);
      // Eligibility and agreement appear only when both documents are published.
      expect(html.match(/<input[^>]*name="handle"/g)).toHaveLength(1);
      expect(html.match(/<input[^>]*name="homeArea"/g)).toHaveLength(1);
      expect(selectField(html, "homeArea")).toContain('role="combobox"');
      expect(html.includes('name="adult"')).toBe(trialRequired);
      expect(html.includes('name="trialAgree"')).toBe(trialRequired);
      expect(html).not.toContain('name="readLangs"');
      expect(html).not.toContain('name="writeLangs"');
      // the options: enabled languages and other; ja selected
      const select = selectField(html, "homeArea");
      expect(optionLabels(select)).toEqual([LANG_LABELS.ja, LANG_LABELS.en, messageMarkup(m.area_other())]);
      expect(select).toMatch(/<input[^>]*name="homeArea"[^>]*value="ja"/);
      expect(select.match(/<button\b[^>]*role="combobox"[^>]*>([\s\S]*?)<\/button>/)![1].replace(/<[^>]*>/g, "")).toContain(LANG_LABELS.ja);
      // the wording
      expect(html).not.toMatch(/言語圏|language area/i);
      expect(html).not.toMatch(/匿名|anonymi/i);
      expect(html).toContain(messageMarkup(m.onboarding_home_area()));
    }
    const ja = await render("onboarding", ["ja", "en"], { defaultMainLang: "other" }, "ja");
    expect(ja).toContain(messageMarkup(operatorCopy(testOperator, "ja").stanceDisclosure));
    expect(ja).toContain(messageMarkup(m.onboarding_purposes({ aiRecipient: operatorCopy(testOperator, "ja").aiRecipient })));
    expect(ja).not.toContain("研究に使うことがあります");
    expect(selectField(ja, "homeArea")).toMatch(/<input[^>]*name="homeArea"[^>]*value="other"/);
    // the disclosure sits above the submit button
    const disclosure = messageMarkup(operatorCopy(testOperator, "ja").stanceDisclosure);
    expect(ja.indexOf(disclosure)).toBeLessThan(ja.indexOf('type="submit"', ja.indexOf(disclosure)));
    const en = await render("onboarding", ["ja", "en"], { defaultMainLang: "en" }, "en");
    expect(en).toContain(messageMarkup(operatorCopy(testOperator, "en").stanceDisclosure));
    expect(en).toContain(messageMarkup(m.onboarding_purposes({ aiRecipient: operatorCopy(testOperator, "en").aiRecipient })));
    expect(en).not.toContain("may be used for research");
  });

  it("uses configured participation labels, policy clauses and age errors alongside shared software facts", async () => {
    const settings = structuredClone(testOperator);
    settings.participation.minimumAge = 23;
    Object.assign(settings.copy.en, {
      aiRecipient: "our selected provider",
      stanceDisclosure: "Our access policy is in the privacy notice.",
      trainingPolicy: ". Our content-use conditions apply.",
      termsLabel: "Community participation terms",
      countryHelp: "Choose your residence for community eligibility.",
      agreementLabel: "I accept the community participation terms.",
      agreementError: "Please review the community participation terms.",
      adultError: "This community requires age {age} or older.",
      reviewTitle: "Review community participation",
      reviewHelp: "Confirm this community's current conditions.",
    });
    const route = await import("~/routes/onboarding");
    for (const error of ["adult_required", "trial_consent_required"]) {
      const html = await renderInRouter(() => createElement(route.default as never, {
        loaderData: { opening: {}, existing: true, countries: [], trialRequired: true, notices: { privacy: true, terms: true } },
        actionData: { error },
      } as never), "/onboarding", undefined, { operator: settings });
      for (const field of ["aiRecipient", "stanceDisclosure", "trainingPolicy", "termsLabel", "countryHelp", "agreementLabel", "reviewTitle", "reviewHelp"] as const) expect(html, field).toContain(messageMarkup(settings.copy.en[field]!));
      expect(html).toContain(messageMarkup(error === "adult_required" ? "This community requires age 23 or older." : settings.copy.en.agreementError!));
      expect(html).not.toContain("{age}");
      expect(html).toContain(messageMarkup(m.onboarding_purposes({ aiRecipient: settings.copy.en.aiRecipient })));
      expect(html).toContain(messageMarkup(m.trial_summary_copyright({ trainingPolicy: settings.copy.en.trainingPolicy })));
    }
  });

  it("keeps the original language explanation in a closed disclosure below the short guidance", async () => {
    for (const locale of ["ja", "en"] as const) {
      const html = await render("onboarding", ["ja", "en"], { defaultMainLang: "en" }, locale);
      const details = html.match(/<details\b[^>]*>[\s\S]*?<\/details>/)![0];
      expect(details).not.toMatch(/<details[^>]*\bopen/);
      expect(details).toContain(messageMarkup(m.onboarding_language_details()));
      expect(details).toContain(messageMarkup(m.onboarding_home_area_help()));
      expect(details).not.toContain(messageMarkup(m.onboarding_language_help()));
      expect(html.indexOf(messageMarkup(m.onboarding_language_help()))).toBeLessThan(html.indexOf(details));
    }
  });

  it("shows an enabled language only: with ja,en,fr the choices are Japanese, English, French and Other", async () => {
    const html = await render("onboarding", ["ja", "en", "fr"], { defaultMainLang: "en" }, "en");
    const select = selectField(html, "homeArea");
    expect(optionLabels(select)).toEqual([LANG_LABELS.ja, LANG_LABELS.en, LANG_LABELS.fr, messageMarkup(m.area_other())]);
    expect(html).not.toContain('value="de"');
  });
});

describe("/settings wording and choices", () => {
  const settingsProps = (over: Record<string, unknown> = {}) => ({
    homeArea: "ja",
    displayLang: null,
    readLangs: ["ja"],
    nextAreaChange: null,
    saved: null,
    emailPref: "daily",
    passkeys: [],
    ...over,
  });
  async function render(enabled: readonly Lang[], props: Record<string, unknown>, locale: "ja" | "en") {
    setTestLocale(locale);
    const mod = await import("~/routes/settings");
    return renderInRouter(() => createElement(mod.default as never, { loaderData: { existing: false, countries: [], trialRequired: false, notices: { privacy: false, terms: false }, ...props }, actionData: undefined, params: {}, matches: [] } as never), "/", undefined, { enabledLangs: enabled });
  }

  it("says main language, not language area; has no writable-languages field; offers the enabled languages for display, reading and the main language", async () => {
    for (const locale of ["ja", "en"] as const) {
      const html = await render(["ja", "en"], settingsProps(), locale);
      expect(html).not.toMatch(/言語圏|language area|home area/i);
      expect(html).not.toContain('name="writeLangs"');
      expect(html).toContain(messageMarkup(m.onboarding_home_area()));
      expect(html).toContain(messageMarkup(m.settings_read_langs_help()));
      // checkboxes of the read languages: ja and en only
      expect([...html.matchAll(/<input[^>]*name="readLangs"[^>]*>/g)].map((m) => /value="([^"]+)"/.exec(m[0])![1])).toEqual(["ja", "en"]);
      // the display language: auto, ja, en; the main language: ja, en, other
      expect(optionLabels(selectField(html, "displayLang"))).toEqual([messageMarkup(m.settings_display_auto()), LANG_LABELS.ja, LANG_LABELS.en]);
      expect(selectField(html, "displayLang")).toMatch(/<option(?=[^>]*value="")(?=[^>]*selected=)[^>]*>/);
      expect(optionLabels(selectField(html, "homeArea"))).toEqual([LANG_LABELS.ja, LANG_LABELS.en, messageMarkup(m.area_other())]);
    }
  });

  it("keeps a main language that is no longer enabled in the choices, marked as not open, so that saving never silently changes it", async () => {
    const html = await render(["ja", "en"], settingsProps({ homeArea: "de" }), "en");
    expect(html).toContain(messageMarkup(m.lang_not_open({ lang: LANG_LABELS.de })));
    const ja = await render(["ja", "en"], settingsProps({ homeArea: "de" }), "ja");
    expect(ja).toContain(messageMarkup(m.lang_not_open({ lang: LANG_LABELS.de })));
  });

  it("the explanation of the main language counts how many languages the marks come from and shows no per-language numbers", async () => {
    for (const locale of ["ja", "en"] as const) {
      const html = await render(["ja", "en"], settingsProps(), locale);
      const details = html.match(/<details\b[^>]*>[\s\S]*?<\/details>/)![0];
      expect(details).not.toMatch(/<details[^>]*\bopen/);
      expect(details).toContain(messageMarkup(m.onboarding_language_details()));
      expect(details).toContain(messageMarkup(m.settings_area_help({ days: HOME_AREA_CHANGE_DAYS })));
      expect(details).not.toContain(messageMarkup(m.settings_area_short_help()));
      expect(html.indexOf(messageMarkup(m.settings_area_short_help()))).toBeLessThan(html.indexOf(details));
    }
  });
});

describe("the wording of the language messages", () => {
  it("never shows the language-area word to members in the signup and settings texts, never says anonymize, and does not frame AI use as an exception", () => {
    const source = JSON.parse(fs.readFileSync("messages/en.json", "utf8")) as Record<string, string>;
    const keys = Object.keys(source).filter((k) => /^(onboarding_|settings_area_|settings_read_langs_|lang_|disclosure_|error_invalid_lang$|nav_areas$)/.test(k));
    expect(keys.length).toBeGreaterThan(15);
    for (const locale of LANGS) {
      const file = JSON.parse(fs.readFileSync(`messages/${locale}.json`, "utf8")) as Record<string, string>;
      for (const key of keys) {
        const text = file[key] ?? (locale !== "en" && locale !== "ja" ? source[key] : undefined);
        expect(text, `${locale} ${key}`).toBeTruthy();
        expect(messageText(text!), `${locale} ${key}`).not.toMatch(/anonymi[sz]|匿名/i);
      }
    }
    const ja = JSON.parse(fs.readFileSync("messages/ja.json", "utf8")) as Record<string, string>;
    const en = JSON.parse(fs.readFileSync("messages/en.json", "utf8")) as Record<string, string>;
    for (const key of keys) {
      expect(ja[key], key).not.toContain("言語圏");
      expect(messageText(en[key]), key).not.toMatch(/language area/i);
    }
  });

  it("the configured stance disclosures contain no anonymization claim, with English fallback", () => {
    for (const locale of LANGS) {
      expect(operatorCopy(testOperator, locale).stanceDisclosure).not.toMatch(/anonym|匿名|anonim|익명|ไม่ระบุตัวตน|ẩn danh|匿名化/i);
    }
  });
});


it("retains a validated onboarding return path through errors, completion and duplicate submissions", async () => {
  const h = await setupRouteHarness();
  try {
    const route = await import("~/routes/onboarding");
    for (const [index, next] of ["/t/5?lang=en#reply", "https://evil.example/", "//evil.example/", "/a/..//evil.example/"].entries()) {
      const handle = `signup_return_${index}`;
      await h.signIn(handle, { profile: false });
      const path = `/onboarding?${new URLSearchParams({ next })}`;
      const request = (name: string) => h.args(h.request(path, { as: handle, form: { ...trialForm, handle: name, homeArea: "en" } }));
      expect(await route.action(request("!"))).toMatchObject({ error: "invalid_handle" });
      const destination = index === 0 ? next : "/";
      expect(await h.outcome(() => route.action(request(handle)))).toMatchObject({ location: destination });
      expect(await h.outcome(() => route.action(request(handle)))).toMatchObject({ location: destination });
      expect(await h.outcome(async () => (await route.loader(h.args(h.request(path, { as: handle })))))).toMatchObject({ location: destination });
    }
  } finally { h.restore(); }
});
