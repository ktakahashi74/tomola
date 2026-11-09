import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { DISPLAY_NAME_MAX, displayNamesVersion, parseDisplayNames, selectDisplayName, updateDisplayNames } from "~/lib/display-names.server";
import { displayNamePresentation, singleDisplayNameField } from "~/lib/display-names";
import { createDisplayNameReport, moderateDisplayName } from "~/lib/display-name-moderation.server";
import { profiles, moderationActions, notifications, reports } from "~/lib/db/schema";
import { listReportCards } from "~/lib/moderation.server";
import { createAppeal, decideAppeal, getAppealableAction } from "~/lib/appeals.server";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import { setTestLocale } from "./stubs/paraglide-runtime";
import { signingCredential } from "./helpers/signing";
import { issueSignedWrite, previewSignedWrite } from "~/lib/signing.server";
import { deleteAccount } from "~/lib/account-delete.server";
import { llmsTxt, helpAiMd } from "~/lib/api/guides.server";

describe("display name input and language selection", () => {
  it("keeps Han spelling only between Japanese and Chinese screens and supplements distinct Latin names", () => {
    for (const homeArea of ["ja", "zh-Hans", "zh-Hant"]) for (const locale of ["ja", "zh-Hans", "zh-Hant", "en", "ko"]) {
      const names = { homeArea, displayName: "陳々・山田·太郎", displayNameLatin: "Taro Yamada" };
      const hanScreen = ["ja", "zh-Hans", "zh-Hant"].includes(locale);
      expect(displayNamePresentation(names, locale)).toEqual({ name: hanScreen ? names.displayName : names.displayNameLatin, latin: hanScreen && homeArea !== locale ? names.displayNameLatin : null });
      expect(selectDisplayName(names, locale)).toBe(hanScreen ? names.displayName : names.displayNameLatin);
    }
    expect(displayNamePresentation({ homeArea: "ko", displayName: "金光", displayNameLatin: "Kim Gwang" }, "ja")).toEqual({ name: "Kim Gwang", latin: null });
  });
  it("requires at least one Han character and rejects mixed scripts and punctuation for cross-language Han names", () => {
    for (const displayName of ["山田たろう", "山田カナ", "山田한", "山田A", "· ・", "山田-太郎", "山田.太郎", "山田𛀀"]) {
      expect(displayNamePresentation({ homeArea: "ja", displayName, displayNameLatin: "Taro Yamada" }, "zh-Hans")).toEqual({ name: "Taro Yamada", latin: null });
    }
    for (const displayName of ["山田 太郎", "陳　光", "佐々木", "𠮷野", "陳·光", "陳・光"]) {
      expect(displayNamePresentation({ homeArea: "ja", displayName, displayNameLatin: null }, "zh-Hant")).toEqual({ name: displayName, latin: null });
      expect(displayNamePresentation({ homeArea: "ja", displayName, displayNameLatin: displayName }, "zh-Hant")).toEqual({ name: displayName, latin: null });
    }
    expect(displayNamePresentation(undefined, "ja")).toEqual({ name: null, latin: null });
    expect(displayNamePresentation({ homeArea: "ja", displayNameLatin: "Taro" }, "zh-Hans")).toEqual({ name: "Taro", latin: null });
  });
  it("uses one Latin-script field unless both stored names differ", () => {
    for (const homeArea of ["en", "fr", "de", "vi"]) {
      for (const names of [{ displayName: null, displayNameLatin: null }, { displayName: "Taylor", displayNameLatin: null }, { displayName: null, displayNameLatin: "Taylor" }, { displayName: "Taylor", displayNameLatin: "Taylor" }]) expect(singleDisplayNameField({ homeArea, ...names })).toBe(true);
      expect(singleDisplayNameField({ homeArea, displayName: "光", displayNameLatin: "Light" })).toBe(false);
    }
    for (const homeArea of ["ja", "zh-Hans", "zh-Hant", "ko", "th", "other"]) expect(singleDisplayNameField({ homeArea })).toBe(false);
  });
  it("trims and normalizes names, accepts empty and nonunique names", () => {
    expect(parseDisplayNames(" 光の書き手 ", " E\u0301toile O’Neil-Smith. ")).toEqual({ displayName: "光の書き手", displayNameLatin: "Étoile O’Neil-Smith." });
    expect(parseDisplayNames("", " ")).toEqual({ displayName: null, displayNameLatin: null });
    expect(parseDisplayNames("A" + "🌞".repeat(DISPLAY_NAME_MAX - 1), "a".repeat(DISPLAY_NAME_MAX))).not.toBeNull();
  });
  it("requires letters and rejects handle sigils and invisible characters in either form", () => {
    for (const value of ["@admin", "＠admin", "﹫admin", "name@other", "...", "- -", "123", "🌞", "\u3164", "A\u3164", "A\u2800", "A\u034f", "A\ufe0f", "A\u115f", "A\uffa0", "A\u200b", "\u200d", "\u200cA", "A\u200d", "A\u200d B", "A\u200d\u200cB"]) {
      expect(parseDisplayNames(value, "Valid"), JSON.stringify(value)).toBeNull();
      expect(parseDisplayNames("名前", value), JSON.stringify(value)).toBeNull();
    }
    expect(parseDisplayNames("ب\u200cت", "Latin")).toEqual({ displayName: "ب\u200cت", displayNameLatin: "Latin" });
    expect(parseDisplayNames("בשם", "Letters ...")).not.toBeNull();
  });
  it("accepts joiners next to native combining marks and rejects every Latin-form joiner", () => {
    for (const name of ["ශ්‍රී", "র‍্য", "ب\u200cت", "A\u200d\u0301B", "A\u0301\u200cB"]) {
      expect(parseDisplayNames(name, "Latin"), name).toMatchObject({ displayName: name.normalize("NFC") });
    }
    for (const name of ["A\u200dB", "A\u200cB", "A\u0301\u200dB", "A\u200c\u0301B"]) expect(parseDisplayNames("名前", name)).toBeNull();
    for (const name of ["\u200d\u0301A", "A\u0301\u200c", "A\u200d B", "A \u200cB", "A\u200d\u200cB", "x \u0301\u200d\u0301", "x \u0301\u200cB", "x\u200d\u0301 "]) expect(parseDisplayNames(name, "Latin")).toBeNull();
  });
  it("identifies handles and optional nonunique names consistently in machine guides", () => {
    for (const guide of [llmsTxt(), helpAiMd()]) {
      expect(guide).toContain("unique username");
      expect(guide).toContain("display_name_latin");
      expect(guide).toContain("nonunique");
      expect(guide).toContain("not proof of identity");
      expect(guide).not.toMatch(/handle is the display name|display names are unique|longest display name/);
    }
  });
  it("rejects controls, direction controls, line separators and excessive length before trimming", () => {
    for (const bad of ["\nx", "x\r", "\tx", "x\0", "x\u007f", "x\u0085", "x\u2028", "x\u2029", "x\u202e", "x\u2066", "x\u200f", "x\ud800", "x".repeat(DISPLAY_NAME_MAX + 1)]) {
      expect(parseDisplayNames(bad, "A"), JSON.stringify(bad)).toBeNull();
      expect(parseDisplayNames("名前", bad), JSON.stringify(bad)).toBeNull();
    }
    for (const latin of ["名前", "Ρaul", "Pаul", "Name123", "<Name>", "\u0301Name"]) expect(parseDisplayNames("名前", latin)).toBeNull();
  });
  it("selects by interface language, then falls back to the only form or no display name", () => {
    for (const homeArea of ["ja", "en", "fr", "other"]) for (const locale of ["ja", "en", "fr"]) {
      expect(selectDisplayName({ homeArea, displayName: "自分の名", displayNameLatin: "Latin Name" }, locale)).toBe(locale === homeArea ? "自分の名" : "Latin Name");
      expect(selectDisplayName({ homeArea, displayName: "自分の名", displayNameLatin: null }, locale)).toBe("自分の名");
      expect(selectDisplayName({ homeArea, displayName: null, displayNameLatin: "Latin Name" }, locale)).toBe("Latin Name");
      expect(selectDisplayName({ homeArea, displayName: null, displayNameLatin: null }, locale)).toBeNull();
    }
  });
});

let h: RouteHarness;
beforeAll(async () => {
  h = await setupRouteHarness();
  for (const name of ["dn_writer", "dn_reporter", "dn_operator", "dn_reviewer", "dn_guarded", "dn_departing", "dn_cleared", "dn_changed", "dn_invalid", "dn_limited"]) await h.signIn(name, { homeArea: "ja", readLangs: ["en"] });
  await h.signIn("dn_single", { homeArea: "en" });
});
afterAll(() => h.restore());

describe("display name settings and moderation", () => {
  it("saves a single field into the native form and clears the Latin form", async () => {
    const id = h.ids.dn_single;
    await updateDisplayNames(h.db, id, "", "Taylor Writer");
    const settings = await import("~/routes/settings");
    expect(await h.outcome(() => settings.action(h.args(h.request("/settings", { as: "dn_single", form: { intent: "display-name", displayName: "Taylor Updated", displayNameLatin: "" } }))))).toMatchObject({ status: 302 });
    expect(await h.db.select().from(profiles).where(eq(profiles.userId, id))).toMatchObject([{ displayName: "Taylor Updated", displayNameLatin: null }]);
    for (const locale of ["en", "ja", "zh-Hans", "ko"]) expect(selectDisplayName((await h.db.select().from(profiles).where(eq(profiles.userId, id)))[0], locale)).toBe("Taylor Updated");
  });
  it("rejects spoofing input through settings and signed previews before storing either form", async () => {
    const route = await import("~/routes/settings");
    const id = h.ids.dn_invalid;
    for (const bad of ["@admin", "＠admin", "﹫admin", "\u3164", "A\u2800", "A\u034f", "\u200d", "A\u200d", "...", "123"]) {
      for (const key of ["displayName", "displayNameLatin"]) {
        const fields = { intent: "display-name", displayName: "Valid", displayNameLatin: "Valid", [key]: bad };
        const form = new FormData(); for (const [key, value] of Object.entries(fields)) form.set(key, value);
        await expect(previewSignedWrite(h.db, id, "/settings", form)).rejects.toMatchObject({ code: "invalid_display_name" });
        const result = await h.outcome(() => route.action(h.args(h.request("/settings", { as: "dn_invalid", form: fields }))));
        expect(result).toMatchObject({ status: 400 });
        expect(result.value).toMatchObject({ data: { error: "invalid_display_name" } });
      }
    }
    expect(await h.db.select().from(profiles).where(eq(profiles.userId, id))).toMatchObject([{ displayName: null, displayNameLatin: null }]);
  });
  it("limits actual changes to five per UTC day, preserves no-op saves and resets the next day", async () => {
    const id = h.ids.dn_limited, now = new Date("2030-01-01T23:59:00Z");
    for (const name of ["First", "Second", "Third", "Fourth", "Fifth"]) {
      expect(await updateDisplayNames(h.db, id, name, "Latin", { now })).toEqual({ ok: true });
      expect(await updateDisplayNames(h.db, id, name, "Latin", { now })).toEqual({ ok: true });
    }
    expect(await updateDisplayNames(h.db, id, "Sixth", "Latin", { now })).toMatchObject({ error: "rate_limited" });
    expect(await h.db.select().from(profiles).where(eq(profiles.userId, id))).toMatchObject([{ displayName: "Fifth" }]);
    expect(await updateDisplayNames(h.db, id, "Tomorrow", "Latin", { now: new Date("2030-01-02T00:00:00Z") })).toEqual({ ok: true });
  });
  it("retains signing and suspension gates and binds both forms to the approval", async () => {
    const id = h.ids.dn_guarded, route = await import("~/routes/settings");
    await h.db.update(profiles).set({ signPosts: true }).where(eq(profiles.userId, id));
    const credential = await signingCredential(h.db, id);
    const fields = { intent: "display-name", displayName: "署名した名前", displayNameLatin: "Signed Name" };
    const unsigned = await h.outcome(() => route.action(h.args(h.request("/settings", { as: "dn_guarded", form: fields }))));
    expect(unsigned.status).toBe(403);
    const form = new FormData(); for (const [key, value] of Object.entries(fields)) form.set(key, value);
    const preview = await previewSignedWrite(h.db, id, "/settings", form);
    expect(preview).toMatchObject({ operation: "change-display-name", signatureRequired: true });
    const proof = await issueSignedWrite(h.db, id, "/settings", form, preview.payloadHash);
    const signedFields = { ...fields, signatureChallenge: proof.challenge, signatureAssertion: JSON.stringify(credential.assert(proof.options.challenge)) };
    const altered = await h.outcome(() => route.action(h.args(h.request("/settings", { as: "dn_guarded", form: { ...signedFields, displayNameLatin: "Altered" } }))));
    expect(altered.status).toBe(409);
    expect((await h.outcome(() => route.action(h.args(h.request("/settings", { as: "dn_guarded", form: signedFields }))))).status).toBe(302);
    await h.db.update(profiles).set({ signPosts: false, suspendedUntil: new Date("2090-01-01"), suspendedReason: "spam" }).where(eq(profiles.userId, id));
    expect(await h.outcome(() => route.action(h.args(h.request("/settings", { as: "dn_guarded", form: { ...fields, displayNameLatin: "Blocked Change" } }))))).toMatchObject({ status: 302, location: "/suspended" });
    expect(await h.db.select().from(profiles).where(eq(profiles.userId, id))).toMatchObject([{ displayNameLatin: "Signed Name" }]);
  });
  it("saves through settings and exports both forms; keeps handles unchanged", async () => {
    const settings = await import("~/routes/settings");
    const response = await settings.action(h.args(h.request("/settings", { as: "dn_writer", form: { intent: "display-name", displayName: " 光の書き手 ", displayNameLatin: "Light Writer" } }))).catch(e => e);
    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(302);
    expect(await h.db.select().from(profiles).where(eq(profiles.userId, h.ids.dn_writer))).toMatchObject([{ handle: "dn_writer", displayName: "光の書き手", displayNameLatin: "Light Writer" }]);
    const { buildMemberExport } = await import("~/lib/exports.server");
    expect((await buildMemberExport(h.db, h.ids.dn_writer)).profile).toMatchObject({ handle: "dn_writer", display_name: "光の書き手", display_name_latin: "Light Writer" });
    setTestLocale("en");
    const route = await import("~/routes/mention-suggest");
    const res = await route.loader(h.args(h.request("/mentions/suggest?q=dn_w", { as: "dn_reporter" }))) as Response;
    expect(await res.json()).toMatchObject({ handles: ["dn_writer"], names: { dn_writer: { displayName: "光の書き手", displayNameLatin: "Light Writer", label: "Light Writer" } } });
  });

  it("reports, clears both forms, notifies and restores on independent appeal", async () => {
    const id = h.ids.dn_cleared;
    await updateDisplayNames(h.db, id, "報告する名前", "Reported Name");
    const report = await createDisplayNameReport(h.db, h.ids.dn_reporter, id, { reason: "harassment" });
    expect(report.ok).toBe(true); if (!report.ok) return;
    expect(await createDisplayNameReport(h.db, h.ids.dn_reporter, id, { reason: "other" })).toMatchObject({ error: "duplicate" });
    expect((await listReportCards(h.db, { operator: false, langs: ["ja"] })).cards.some(c => c.kind === "display_name")).toBe(false);
    expect((await listReportCards(h.db, { operator: true, langs: [] }, { viewerId: id })).cards.some(c => c.kind === "display_name")).toBe(false);
    expect((await listReportCards(h.db, { operator: true, langs: [] }, { viewerId: h.ids.dn_operator })).cards).toContainEqual(expect.objectContaining({ kind: "display_name", displayNameLatin: "Reported Name" }));
    const input = { userId: id, reportId: report.id, version: displayNamesVersion({ displayName: "報告する名前", displayNameLatin: "Reported Name" }), dismiss: false, reason: "harassment", note: "Impersonation" };
    expect(await moderateDisplayName(h.db, { id, scope: { operator: true, langs: [] } }, input)).toMatchObject({ error: "own_entry" });
    expect(await moderateDisplayName(h.db, { id: h.ids.dn_operator, scope: { operator: false, langs: ["ja"] } }, input)).toMatchObject({ error: "forbidden" });
    const result = await moderateDisplayName(h.db, { id: h.ids.dn_operator, scope: { operator: true, langs: [] } }, input);
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(await h.db.select().from(profiles).where(eq(profiles.userId, id))).toMatchObject([{ displayName: null, displayNameLatin: null, displayNameActionId: result.actionId }]);
    expect(await h.db.select().from(notifications).where(eq(notifications.actionId, result.actionId))).toMatchObject([{ userId: id, kind: "moderation" }]);
    expect(await getAppealableAction(h.db, h.ids.dn_reporter, result.actionId)).toBeNull();
    const appeal = await createAppeal(h.db, id, result.actionId, "Please review");
    expect(appeal.ok).toBe(true); if (!appeal.ok) return;
    const decide = (reviewer: string) => decideAppeal(h.db, { id: h.ids[reviewer], scope: { operator: true, langs: [] } }, appeal.id, { decision: "overturned", note: "Name is allowed" });
    expect(await decide("dn_operator")).toMatchObject({ error: "own_action" });
    expect(await decide("dn_reporter")).toMatchObject({ error: "reporter" });
    expect(await decide("dn_reviewer")).toMatchObject({ ok: true, reversed: true });
    expect(await h.db.select().from(profiles).where(eq(profiles.userId, id))).toMatchObject([{ displayName: "報告する名前", displayNameLatin: "Reported Name" }]);
    expect(await h.db.select().from(moderationActions).where(eq(moderationActions.id, result.actionId))).toMatchObject([{ action: "clear_display_name" }]);
  });

  it("keeps reported names and open reports after a change, rejects stale actions and preserves later choices", async () => {
    const id = h.ids.dn_changed;
    const old = { displayName: "前の名前", displayNameLatin: "Old Name" };
    await updateDisplayNames(h.db, id, old.displayName, old.displayNameLatin);
    const report = await createDisplayNameReport(h.db, h.ids.dn_reporter, id, { reason: "other" });
    if (!report.ok) throw Error(report.error);
    await updateDisplayNames(h.db, id, "新しい名前", "New Name");
    expect(await h.db.select().from(reports).where(eq(reports.id, report.id))).toMatchObject([{ status: "open", displayNamesReported: old, handledAt: null }]);
    expect(await createDisplayNameReport(h.db, h.ids.dn_reporter, id, { reason: "other" })).toMatchObject({ error: "duplicate" });
    const card = (await listReportCards(h.db, { operator: true, langs: [] }, { viewerId: h.ids.dn_operator })).cards.find(c => c.kind === "display_name" && c.userId === id);
    expect(card).toMatchObject({ displayName: "新しい名前", reports: [{ names: old }] });
    const input = { userId: id, reportId: report.id, dismiss: false, reason: "other", note: "Review", version: displayNamesVersion(old) };
    expect(await moderateDisplayName(h.db, { id: h.ids.dn_operator, scope: { operator: true, langs: [] } }, input)).toMatchObject({ error: "invalid_state" });
    const cleared = await moderateDisplayName(h.db, { id: h.ids.dn_operator, scope: { operator: true, langs: [] } }, { ...input, version: displayNamesVersion({ displayName: "新しい名前", displayNameLatin: "New Name" }) });
    if (!cleared.ok) throw Error(cleared.error);
    const appeal = await createAppeal(h.db, id, cleared.actionId, "Review");
    if (!appeal.ok) throw Error(appeal.error);
    await updateDisplayNames(h.db, id, "本人の選択", "Chosen Name");
    expect(await decideAppeal(h.db, { id: h.ids.dn_reviewer, scope: { operator: true, langs: [] } }, appeal.id, { decision: "overturned", note: "Allowed" })).toMatchObject({ ok: true, reversed: false });
    expect(await h.db.select().from(profiles).where(eq(profiles.userId, id))).toMatchObject([{ displayNameLatin: "Chosen Name" }]);
  });

  it("removes both forms and saved restoration data when the member leaves", async () => {
    const id = h.ids.dn_departing;
    await updateDisplayNames(h.db, id, "退会する名前", "Departing Name");
    const report = await createDisplayNameReport(h.db, h.ids.dn_reporter, id, { reason: "other" });
    if (!report.ok) throw Error(report.error);
    const cleared = await moderateDisplayName(h.db, { id: h.ids.dn_operator, scope: { operator: true, langs: [] } }, { userId: id, reportId: report.id, version: displayNamesVersion({ displayName: "退会する名前", displayNameLatin: "Departing Name" }), dismiss: false, reason: "other", note: "Review" });
    if (!cleared.ok) throw Error(cleared.error);
    await deleteAccount(h.db, id, { confirmation: "dn_departing" });
    expect(await h.db.select().from(profiles).where(eq(profiles.userId, id))).toEqual([]);
    const [action] = await h.db.select().from(moderationActions).where(eq(moderationActions.id, cleared.actionId));
    expect(action.displayNamesBefore).toBeNull();
    expect(await h.db.select().from(reports).where(eq(reports.id, report.id))).toMatchObject([{ displayNamesReported: null }]);
  });
});
