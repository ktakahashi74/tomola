import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { entries, jobs, translations, user, villages } from "~/lib/db/schema";
import { DELETED_MEMBER_EMAIL, DELETED_MEMBER_ID } from "~/lib/deleted-member";
import { createReply, createTopic } from "~/lib/entries.server";
import { loadEntryDisplays, loadPickedTranslations, loadTitleDisplays } from "~/lib/entry-display.server";
import { loadFeedItems } from "~/lib/feeds.server";
import { createTranslationHandlers } from "~/lib/jobs/translation-jobs.server";
import { LANGS, type Lang } from "~/lib/languages";
import { createFakeEngine, createFakeJudge } from "~/lib/llm/engines/fake.server";
import { LlmError } from "~/lib/llm/errors.server";
import type { TranslationRequest } from "~/lib/llm/types";
import { loadMdTranslations } from "~/lib/md/translations.server";
import { mentionTokens } from "~/lib/mentions-md.server";
import { parseResponsePost, responsePostLine, responsePostPrefill } from "~/lib/response-post.server";
import { localizeResponseBodies, prepareResponsePostTranslation } from "~/lib/response-line.server";
import { topicShare } from "~/lib/share-preview.server";
import { exportSite } from "~/lib/site-export.server";
import { createTranslationReport } from "~/lib/translation-reports.server";
import { addMember, createTestDb } from "./helpers/db";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));

it.each(LANGS)("recognizes complete generated paragraphs in %s, including escaped labels and untitled posts", lang => {
  for (const title of [null, "Old [title] \\ *term* &amp; <tag> (@someone)"]) for (const handle of ["zsource", null]) {
    const line = responsePostLine(42, title, handle, lang);
    expect(parseResponsePost(`${line}\n\nMy response`, lang)).toEqual({ topicId: 42, line, body: "My response" });
    expect(parseResponsePost(line, lang)?.topicId).toBe(42);
    expect(parseResponsePost(`${line}\r\n\r\nRest`, lang)?.body).toBe("Rest");
    for (const changed of [`My ${line}`, `${line}!`, `${line}\ncontinued`, `[Other post](/t/42)\n\nRest`, `\n${line}`, line.replace("/t/42", "/t/42#reply"), line.replace("/t/42", "/t/9007199254740992")]) {
      expect(parseResponsePost(changed, lang)).toBeNull();
    }
  }
});

it("does not recognize the generated wording of a different source language", () => {
  expect(parseResponsePost(responsePostLine(42, "題", "zsource", "ja"), "en")).toBeNull();
});

async function fixture(title: string | null = "原題", changed = false, departed = false, openingLang: Lang = "ja") {
  const db = await createTestDb();
  await addMember(db, "origin", "zsource");
  await addMember(db, "responder", "zresponder");
  const source = await createTopic(db, "origin", { lang: "ja", ...(title === null ? {} : { title }), body: "元の論考。" });
  if (!source.ok) throw new Error(source.error);
  if (departed) {
    await db.insert(user).values({ id: DELETED_MEMBER_ID, name: "", email: DELETED_MEMBER_EMAIL });
    await db.update(entries).set({ authorId: DELETED_MEMBER_ID }).where(eq(entries.id, source.id));
  }
  const opening = (await responsePostPrefill(db, String(source.id), openingLang))!.prefill.body;
  const body = (changed ? `自分の言葉：${opening}` : opening) + "応答の本文。";
  const result = await createTopic(db, "responder", { lang: "ja", body });
  if (!result.ok) throw new Error(result.error);
  const [response] = await db.select().from(entries).where(eq(entries.id, result.id));
  const input = { ...response, kind: "topic" as const, lang: "ja" as const };
  const calls: TranslationRequest[] = [];
  const fake = createFakeEngine();
  const primary = { ...fake, async translate(req: TranslationRequest) { calls.push(req); return fake.translate(req); } };
  const handlers = createTranslationHandlers({ llm: { engines: { primary, secondary: createFakeEngine(), judge: createFakeJudge() }, env: { DIVERGENCE_SAMPLE_RATE: "1" } } });
  const [job] = await db.select().from(jobs).where(and(eq(jobs.kind, "translate_entry"), eq(jobs.payload, { entryId: response.id, lang: "en", sourceHash: response.sourceHash! })));
  if (!job) throw new Error("Missing translation job");
  const run = () => handlers.translate_entry(job, { db, now: new Date() });
  const targetWhere = and(eq(translations.entryId, source.id), eq(translations.lang, "en"), eq(translations.field, "title"));
  const saveTitle = async (text: string) => {
    const [current] = await db.select().from(entries).where(eq(entries.id, source.id));
    await db.insert(translations).values({ entryId: source.id, lang: "en", field: "title", kind: "primary", text, sourceHash: current.sourceHash, mentionRevision: current.mentionRevision })
      .onConflictDoUpdate({ target: [translations.entryId, translations.field, translations.lang, translations.kind], set: { text, sourceHash: current.sourceHash, mentionRevision: current.mentionRevision } });
  };
  const bodyRows = () => db.select().from(translations).where(and(eq(translations.entryId, response.id), eq(translations.lang, "en"), eq(translations.field, "body")));
  return { db, source, input, opening, body, calls, run, job, handlers, saveTitle, targetWhere, bodyRows };
}
const opts = { readLangs: ["en" as const], displayLang: "en" as const };

it("sends only the remaining body to the fake engine and restores a localized title link without mentions or quality flags", async () => {
  const f = await fixture();
  await f.saveTitle("Canonical **term** &amp; [title]");
  await f.run();
  expect(f.calls.map(c => c.text)).toEqual(["応答の本文。"]);
  const [row] = await f.bodyRows();
  expect(row.text).toBe(responsePostLine(f.source.id, "Canonical **term** &amp; [title]", "zsource", "en") + "\n\n[en] 応答の本文。");
  expect(row.flags).toEqual([]);
  expect(await mentionTokens(row.text)).toEqual([]);
  const display = (await loadEntryDisplays(f.db, [f.input], opts)).get(f.input.id)!;
  expect(display.shown).toBe("translation");
  expect(display.translation?.html).toContain(`href="/t/${f.source.id}"`);
  expect(display.translation?.html).not.toContain("mention");
  // Secondary translation and divergence retain complete matching bodies.
  await f.handlers.measure_divergence(f.job, { db: f.db, now: new Date() });
  expect((await f.bodyRows()).find(r => r.kind === "secondary")?.text).toBe(row.text);
});

it.each([null, "原題"])("falls back to the original title or an untitled link (%s)", async title => {
  const f = await fixture(title);
  await f.run();
  expect((await f.bodyRows())[0].text.startsWith(responsePostLine(f.source.id, title, "zsource", "en"))).toBe(true);
});

it("recognizes the interface opening when the response body is written in another language", async () => {
  const f = await fixture("原題", false, false, "en");
  expect(parseResponsePost(f.body)?.topicId).toBe(f.source.id);
  await f.run();
  expect(f.calls.map(call => call.text)).toEqual(["応答の本文。"]);
  expect((await f.bodyRows())[0].text).toBe(responsePostLine(f.source.id, "原題", "zsource", "en") + "\n\n[en] 応答の本文。");
});

it("passes original author terminology for responses with an opening in the interface language", async () => {
  const declaration = "三重の灯（英語では Lantern Triad）";
  const f = await fixture("引用題（英語では Opening Only）", false, false, "en");
  await f.db.update(entries).set({ body: `${declaration}を使う。` }).where(eq(entries.id, f.source.id));
  await f.run();
  const terms = f.calls[0]?.terminology;
  expect(terms?.response?.author).toEqual([declaration]);
  expect(terms?.author).toEqual([]);
});

it.each([null, "原題"])("keeps departed-author openings out of translation and projects the same public post link (%s)", async title => {
  const f = await fixture(title, false, true);
  expect(parseResponsePost(f.opening, "ja")?.topicId).toBe(f.source.id);
  expect(f.opening).not.toContain("@");
  await f.saveTitle("Translated title");
  await f.run();
  expect(f.calls.map(call => call.text)).toEqual(["応答の本文。"]);
  const expected = responsePostLine(f.source.id, title === null ? null : "Translated title", null, "en");
  expect((await f.bodyRows())[0].text).toBe(expected + "\n\n[en] 応答の本文。");
  const shown = (await loadPickedTranslations(f.db, [f.input], "en")).get(f.input.id)!.body!;
  expect(shown.text.startsWith(expected)).toBe(true);
  expect(await mentionTokens(shown.text)).toEqual([]);
  const html = (await loadEntryDisplays(f.db, [f.input], opts)).get(f.input.id)!.translation!.html;
  expect(html).toContain(`href="/t/${f.source.id}"`);
  expect(html).not.toContain('href="/u/');
});

it("projects a departed-author opening when the source author leaves after the response was translated", async () => {
  const f = await fixture();
  await f.run();
  await f.db.insert(user).values({ id: DELETED_MEMBER_ID, name: "", email: DELETED_MEMBER_EMAIL });
  await f.db.update(entries).set({ authorId: DELETED_MEMBER_ID }).where(eq(entries.id, f.source.id));
  const shown = (await loadPickedTranslations(f.db, [f.input], "en")).get(f.input.id)!.body!;
  expect(shown.text).toBe(responsePostLine(f.source.id, "原題", null, "en") + "\n\n[en] 応答の本文。");
});

it("translates an author's changed opening as ordinary body text", async () => {
  const f = await fixture("原題", true);
  await f.run();
  expect(f.calls.map(c => c.text)).toEqual([f.body]);
  expect((await f.bodyRows())[0].text).toBe(`[en] ${f.body}`);
});

it("excludes the generated line on fallback and on a report retry", async () => {
  const f = await fixture();
  const fake = createFakeEngine();
  const sent: TranslationRequest[] = [];
  const secondary = { ...fake, async translate(req: TranslationRequest) { sent.push(req); return fake.translate(req); } };
  const handlers = createTranslationHandlers({ llm: { engines: {
    primary: { ...fake, async translate() { throw new LlmError("refusal", "Test refusal"); } }, secondary, retry: secondary, judge: null,
  }, env: {} } });
  await handlers.translate_entry(f.job, { db: f.db, now: new Date() });
  expect(sent.map(r => r.text)).toEqual(["応答の本文。"]);
  expect((await f.bodyRows())[0].fallback).toBe(true);
  const [beforeRetry] = await f.bodyRows();
  await f.saveTitle("A newly translated title");
  const report = await createTranslationReport(f.db, "origin", { entryId: f.input.id, lang: "en", field: "body", excerpt: "", note: "" },
    { llm: { engines: { primary: fake, secondary: null, retry: secondary, judge: null }, env: {} } });
  expect(report.ok).toBe(true);
  const [retry] = await f.db.select().from(jobs).where(eq(jobs.kind, "retranslate_after_report"));
  await handlers.retranslate_after_report(retry, { db: f.db, now: new Date() });
  expect(sent.map(r => r.text)).toEqual(["応答の本文。", "応答の本文。"]);
  expect((await f.bodyRows())[0]).toEqual(beforeRetry);
});

it("refreshes late or changed title translations across HTML, cards, Markdown, lists, feeds, share previews and site exports without changing stored evidence", async () => {
  const f = await fixture();
  await f.run();
  const [stored] = await f.bodyRows();
  await f.saveTitle("Canonical term");
  // The original title may change after the response was written.
  await f.db.update(entries).set({ title: "後の原題" }).where(eq(entries.id, f.source.id));
  const expected = responsePostLine(f.source.id, "Canonical term", "zsource", "en");
  const picked = (await loadPickedTranslations(f.db, [f.input], "en")).get(f.input.id)!.body!;
  expect(picked.text.startsWith(expected)).toBe(true);
  const display = (await loadEntryDisplays(f.db, [f.input], opts)).get(f.input.id)!;
  expect(display.translation?.html).toContain("Canonical term");
  const card = (await loadEntryDisplays(f.db, [f.input], { ...opts, variant: "card" })).get(f.input.id)!;
  expect(card.translation?.html).toContain("Canonical term");
  const md = await loadMdTranslations(f.db, [f.input], "en");
  expect(md.shown.get(f.input.id)?.[0].text.startsWith(expected)).toBe(true);
  expect((await loadTitleDisplays(f.db, [{ ...f.input, title: null }], opts)).get(f.input.id)?.text).toContain("Canonical term");
  expect((await loadFeedItems(f.db, { kind: "all" }, "en")).find(item => item.link.includes(`/t/${f.input.id}?`))?.description).toContain("Canonical term");
  expect((await topicShare(f.db, f.input, "?lang=en")).description).toContain("Canonical term");
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "response-export-"));
  try {
    await exportSite(f.db, { outDir: path.join(temp, "site"), langs: ["en"] });
    expect(await fs.readFile(path.join(temp, `site/en/t/${f.input.id}.md`), "utf8")).toContain("Canonical term");
    expect(await fs.readFile(path.join(temp, `site/en/t/${f.input.id}.html`), "utf8")).toContain("Canonical term");
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
  expect((await f.bodyRows())[0]).toEqual(stored);
  await f.saveTitle("Revised canonical term");
  expect((await loadMdTranslations(f.db, [f.input], "en")).shown.get(f.input.id)?.[0].text).toContain("Revised canonical term");
});

it.each(["hidden", "deleted", "closed"])("does not resolve or retain a translated title for a %s target", async state => {
  const f = await fixture();
  await f.saveTitle("DO-NOT-EXPOSE");
  await f.run();
  if (state === "closed") {
    const [village] = await f.db.insert(villages).values({ kind: "closed", name: "Private" }).returning();
    await f.db.update(entries).set({ villageId: village.id }).where(eq(entries.id, f.source.id));
  } else await f.db.update(entries).set({ [state === "hidden" ? "hiddenAt" : "deletedAt"]: new Date() }).where(eq(entries.id, f.source.id));
  expect(await prepareResponsePostTranslation(f.db, f.body, "ja", "en")).toBeNull();
  const picked = (await loadPickedTranslations(f.db, [f.input], "en")).get(f.input.id)!.body!;
  expect(picked.text).not.toContain("DO-NOT-EXPOSE");
  expect(picked.text).toBe(f.opening + "[en] 応答の本文。");
  const md = await loadMdTranslations(f.db, [f.input], "en");
  expect(md.shown.get(f.input.id)?.[0].text).toBe(picked.text);
});

it("translates an opening with no body after it as ordinary text", async () => {
  const f = await fixture();
  expect(await prepareResponsePostTranslation(f.db, f.opening, "ja", "en")).toBeNull();
  expect(await prepareResponsePostTranslation(f.db, `${f.opening} \n`, "ja", "en")).toBeNull();
});

it("preserves human corrections and ignores hidden or outdated machine title rows", async () => {
  const f = await fixture();
  await f.saveTitle("HIDDEN-TITLE");
  await f.db.update(translations).set({ flags: ["untranslated"] }).where(f.targetWhere);
  await f.run();
  expect((await f.bodyRows())[0].text).not.toContain("HIDDEN-TITLE");
  await f.db.update(translations).set({ flags: [], sourceHash: "outdated" }).where(f.targetWhere);
  expect((await prepareResponsePostTranslation(f.db, f.body, "ja", "en"))?.line).toBe(responsePostLine(f.source.id, "原題", "zsource", "en"));
  const [source] = await f.db.select().from(entries).where(eq(entries.id, f.source.id));
  await f.db.insert(translations).values({ entryId: source.id, field: "title", lang: "en", kind: "human", text: "Human title", sourceHash: source.sourceHash });
  expect((await prepareResponsePostTranslation(f.db, f.body, "ja", "en"))?.line).toBe(responsePostLine(f.source.id, "Human title", "zsource", "en"));
  const row = { ...(await f.bodyRows())[0], kind: "human", text: "My corrected opening\n\nMy corrected body" };
  expect(await localizeResponseBodies(f.db, [row])).toEqual([row]);
  const unchangedOpening = { ...row, text: responsePostLine(source.id, "Previous title", "zsource", "en") + "\n\nMy corrected body" };
  expect((await localizeResponseBodies(f.db, [unchangedOpening]))[0].text)
    .toBe(responsePostLine(source.id, "Human title", "zsource", "en") + "\n\nMy corrected body");
});

it("leaves missing and reply targets to ordinary translation", async () => {
  const f = await fixture();
  const reply = await createReply(f.db, "origin", f.source.id, { lang: "ja", body: "返信。" });
  if (!reply.ok) throw new Error(reply.error);
  for (const id of [reply.id, 99999999]) {
    expect(await prepareResponsePostTranslation(f.db, responsePostLine(id, "題", "zsource", "ja") + "\n\n本文。", "ja", "en")).toBeNull();
  }
});
