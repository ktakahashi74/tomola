import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { profiles, translationReports, translations } from "~/lib/db/schema";
import { createTopic } from "~/lib/entries.server";
import { grantModerator } from "~/lib/roles.server";
import { createTranslationReport, dismissReport, listOpenReports, resolveReportWithHumanTranslation } from "~/lib/translation-reports.server";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

// Translation reports and human corrections (/admin/translations) are also open to moderators, limited to translations into their assigned language. Operators can handle all languages.
let h: RouteHarness;
let enTopic: number;
let jaTopic: number;
let reportFr: number;
let reportEn: number;
let reportJa: number;
const saved = process.env.OPERATOR_EMAILS;

beforeAll(async () => {
  process.env.OPERATOR_EMAILS = "opal@example.com";
  h = await setupRouteHarness();
  await h.signIn("hana", { homeArea: "ja", readLangs: ["ja", "en"] });
  await h.signIn("frmod", { homeArea: "ja", readLangs: ["ja"] });
  await h.signIn("enmod", { homeArea: "ja", readLangs: ["ja"] });
  await h.signIn("opal", { homeArea: "ja", readLangs: ["ja"] });
  await h.signIn("plain", { homeArea: "ja", readLangs: ["ja"] });
  await grantModerator(h.db, h.ids.opal, h.ids.frmod, "fr");
  await grantModerator(h.db, h.ids.opal, h.ids.enmod, "en");
  const a = await createTopic(h.db, h.ids.hana, { lang: "ja", title: "日本語の話題", body: "本文です。" });
  const b = await createTopic(h.db, h.ids.hana, { lang: "en", title: "English topic", body: "Body." });
  if (!a.ok || !b.ok) throw new Error("topic failed");
  jaTopic = a.id;
  enTopic = b.id;
  const r1 = await createTranslationReport(h.db, h.ids.plain, { entryId: jaTopic, lang: "fr", field: "body", excerpt: "x", note: "" });
  const r2 = await createTranslationReport(h.db, h.ids.plain, { entryId: jaTopic, lang: "en", field: "body", excerpt: "x", note: "" });
  // A Japanese translation of an English topic has target language ja, with no assigned moderator; only the operator can handle it.
  const r3 = await createTranslationReport(h.db, h.ids.plain, { entryId: enTopic, lang: "ja", field: "body", excerpt: "x", note: "" });
  if (!r1.ok || !r2.ok || !r3.ok || r1.id === null || r2.id === null || r3.id === null) throw new Error("report failed");
  reportFr = r1.id;
  reportEn = r2.id;
  reportJa = r3.id;
});
afterAll(() => {
  h.restore();
  if (saved === undefined) delete process.env.OPERATOR_EMAILS;
  else process.env.OPERATOR_EMAILS = saved;
});

describe("the translation reports a moderator sees", () => {
  it("lists only the reports whose target language is one of the moderator's; an operator sees all; nobody else", async () => {
    expect((await listOpenReports(h.db)).map((r) => r.id).sort()).toEqual([reportFr, reportEn, reportJa].sort());
    expect((await listOpenReports(h.db, { scope: { operator: false, langs: ["fr"] } })).map((r) => r.id)).toEqual([reportFr]);
    expect((await listOpenReports(h.db, { scope: { operator: false, langs: ["fr", "en"] } })).map((r) => r.id).sort()).toEqual([reportFr, reportEn].sort());
    expect((await listOpenReports(h.db, { scope: { operator: false, langs: [] } }))).toEqual([]);
    expect((await listOpenReports(h.db, { scope: { operator: true, langs: [] } })).length).toBe(3);
  });

  it("the route: moderators and operators open it (visitors go to the login, plain members get 404), each with their own list", async () => {
    const { loader } = await import("~/routes/admin-translations");
    const call = (as?: string) => h.outcome(async () => (await loader(h.args(h.request("/admin/translations", { as })))));
    expect(await call()).toMatchObject({ status: 302, location: "/login?next=%2Fadmin%2Ftranslations" });
    expect(await call("plain")).toMatchObject({ status: 404 });
    const ids = async (as: string) => ((await call(as)).value as { reports: Array<{ id: number }> }).reports.map((r) => r.id).sort();
    expect(await ids("frmod")).toEqual([reportFr]);
    expect(await ids("enmod")).toEqual([reportEn]);
    expect(await ids("opal")).toEqual([reportFr, reportEn, reportJa].sort());
  });
});

describe("writing a human fix", () => {
  it("checks the origin before authentication or changing a translation report", async () => {
    const { action } = await import("~/routes/admin-translations");
    for (const as of [undefined, "frmod"]) {
      const request = h.request("/admin/translations", { as, form: { reportId: String(reportFr), intent: "dismiss" }, headers: { Origin: "https://other.example" } });
      expect(await h.outcome(() => action(h.args(request)))).toMatchObject({ status: 403 });
    }
    expect((await h.db.select().from(translationReports).where(eq(translationReports.id, reportFr)))[0].status).toBe("open");
  });

  it("is allowed for the moderator of the target language only, through the writer gate", async () => {
    const { action } = await import("~/routes/admin-translations");
    const post = (as: string, form: Record<string, string>) => h.outcome(() => action(h.args(h.request("/admin/translations", { as, form }))));
    // A moderator of another language cannot act; nothing is written.
    expect(await post("enmod", { reportId: String(reportFr), text: "Corps corrigé." })).toMatchObject({ status: 403 });
    expect(await post("plain", { reportId: String(reportFr), text: "x" })).toMatchObject({ status: 404 });
    expect(await h.db.select().from(translations).where(eq(translations.kind, "human"))).toEqual([]);
    expect((await h.db.select().from(translationReports).where(eq(translationReports.id, reportFr)))[0].status).toBe("open");
    // The assigned moderator can write; the report becomes resolved and records the editor.
    expect(await post("frmod", { reportId: String(reportFr), text: "Corps corrigé." })).toMatchObject({ status: 302, location: "/admin/translations" });
    expect((await h.db.select().from(translations).where(eq(translations.kind, "human")))[0]).toMatchObject({ entryId: jaTopic, lang: "fr", text: "Corps corrigé.", createdBy: h.ids.frmod });
    expect((await h.db.select().from(translationReports).where(eq(translationReports.id, reportFr)))[0]).toMatchObject({ status: "resolved", resolvedBy: h.ids.frmod });
    // Closing a report without changing the translation is also limited to the assigned language.
    expect((await post("frmod", { reportId: String(reportEn), intent: "dismiss" })).status).toBe(302);
    expect((await h.db.select().from(translationReports).where(eq(translationReports.id, reportEn)))[0].status).toBe("open");
    expect((await post("enmod", { reportId: String(reportEn), intent: "dismiss" })).status).toBe(302);
    expect((await h.db.select().from(translationReports).where(eq(translationReports.id, reportEn)))[0].status).toBe("resolved");
    // An operator can also write translations into an unassigned language, here Japanese.
    expect(await post("opal", { reportId: String(reportJa), text: "直した訳。" })).toMatchObject({ status: 302 });
    expect(await resolveReportWithHumanTranslation(h.db, "x", reportJa, "again", { scope: { operator: false, langs: ["ja"] } })).toEqual({ ok: false, error: "not_found" });
    expect(await dismissReport(h.db, "x", reportJa, { scope: { operator: false, langs: ["ja"] } })).toBe(false);
  });

  it("is refused for a suspended moderator", async () => {
    const { action } = await import("~/routes/admin-translations");
    const again = await createTranslationReport(h.db, h.ids.hana, { entryId: jaTopic, lang: "fr", field: "title", excerpt: "x", note: "" });
    if (!again.ok || again.id === null) throw new Error("report failed");
    await h.db.update(profiles).set({ suspendedUntil: new Date(Date.now() + 86_400_000), suspendedReason: "spam" }).where(eq(profiles.userId, h.ids.frmod));
    const res = await h.outcome(() => action(h.args(h.request("/admin/translations", { as: "frmod", form: { reportId: String(again.id), text: "Titre" } }))));
    expect(res).toMatchObject({ status: 302, location: "/suspended" });
    expect((await h.db.select().from(translationReports).where(eq(translationReports.id, again.id)))[0].status).toBe("open");
  });
});
