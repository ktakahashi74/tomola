import { quietLogger as quiet } from "./helpers/logger";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "~/lib/db/client.server";
import { profiles, translations } from "~/lib/db/schema";
import { createReply, createTopic } from "~/lib/entries.server";
import { createTranslationHandlers } from "~/lib/jobs/translation-jobs.server";
import { runDueJobs } from "~/lib/jobs/queue.server";
import { detectCopy } from "~/lib/llm/copy-detection.server";
import { createFakeEngine, createFakeJudge } from "~/lib/llm/engines/fake.server";
import { FLAG_QUALITY_MISMATCH, FLAG_UNTRANSLATED } from "~/lib/llm/flags";
import { buildTranslationPrompt, PROMPT_VERSION, translationSystemPrompt } from "~/lib/llm/prompt.server";
import { checkStructure } from "~/lib/llm/structure.server";
import { translateChecked } from "~/lib/llm/translate.server";
import type { TranslationEngine, TranslationRequest } from "~/lib/llm/types";
import { markdownToPlainText, plainExcerpt } from "~/lib/plain-text.server";
import { loadEntryDisplays } from "~/lib/entry-display.server";
import { addMember, createTestDb } from "./helpers/db";

// Mentions through translation: the prompt rule, the structure check (the mentions of the source must be in the translation), the retry, the near-copy detector
// and the plain-text excerpts, and the job that hands the mentions to the engine.
describe("the prompt", () => {
  it("tells the translator to keep every @mention as written, in every target language", () => {
    for (const to of ["en", "fr", "zh-Hans", "zh-Hant", "ko", "th", "vi", "de"] as const) {
      const system = translationSystemPrompt("ja", to);
      expect(system, to).toMatch(/@mention.*exactly as written/);
      const mentionRule = system.match(/Keep every @mention[^\n]+/)![0];
      for (const action of ["translate", "transliterate", "respace", "remove"]) expect(mentionRule, to).toMatch(new RegExp(`do not[^.]*${action}`));
    }
    expect(buildTranslationPrompt({ text: "@hana さんへ", from: "ja", to: "en", mentions: ["@hana"] }).system).toContain("@mention");
  });
});

describe("checkStructure with mentions", () => {
  it("passes when every mention of the source is in the translation, and the other checks still run", async () => {
    const check = (await checkStructure("@hana さんへ。`code`", "To @hana. `code`", { mentions: ["@hana"] }));
    expect(check).toEqual({ ok: true, mismatches: [], flags: [] });
  });

  it("reports a mention that is lost, as a strong preservation failure", async () => {
    for (const lost of ["To Hana.", "To ＠ハナ.", "To @ hana.", "To @han."]) {
      const check = (await checkStructure("@hana さんへ。", lost, { mentions: ["@hana"] }));
      expect(check, lost).toMatchObject({ ok: false, mismatches: ["mentions: @hana missing"], flags: [FLAG_QUALITY_MISMATCH] });
    }
  });

  it("compares after NFKC and lower case: a full-width sigil or letters, another case, are the same mention", async () => {
    expect((await checkStructure("＠Hana へ", "To @hana", { mentions: ["＠Hana"] })).ok).toBe(true);
    expect((await checkStructure("@hana へ", "To ＠ＨＡＮＡ", { mentions: ["@hana"] })).ok).toBe(true);
  });

  it("needs the mention in the prose of the translation, not only in its code", async () => {
    expect((await checkStructure("@hana へ", "`@hana`", { mentions: ["@hana"] })).ok).toBe(false);
    expect((await checkStructure("@hana へ", "```\n@hana\n```", { mentions: ["@hana"] })).ok).toBe(false);
  });

  it("checks each of several mentions, and a mention that sits inside a quote", async () => {
    const check = (await checkStructure("> @ben said\n\n@hana へ", "> ben said\n\nTo @hana", { mentions: ["@ben", "@hana"] }));
    expect(check.mismatches).toEqual(["mentions: @ben missing"]);
  });

  it("is the same as before without mentions", async () => {
    expect((await checkStructure("text", "text"))).toEqual({ ok: true, mismatches: [], flags: [] });
    expect((await checkStructure("text", "text", { mentions: [] })).ok).toBe(true);
  });
});

describe("translateChecked", () => {
  const req: TranslationRequest = { text: "@hana さん、ご確認ください。", from: "ja", to: "en", mentions: ["@hana"] };
  const engine = (outputs: string[], seen: TranslationRequest[]): TranslationEngine => ({
    id: "claude",
    model: "m",
    async translate(r) {
      seen.push(r);
      return { text: outputs[Math.min(seen.length - 1, outputs.length - 1)], model: "m", promptVersion: PROMPT_VERSION, inputTokens: 1, outputTokens: 1 };
    },
  });

  it("translates again once, with a note about the mention, when the first translation lost it; the second one is taken", async () => {
    const seen: TranslationRequest[] = [];
    const out = await translateChecked(engine(["Hana, please check this.", "@hana, please check this."], seen), req);
    expect(out).toMatchObject({ text: "@hana, please check this.", flags: [], attempts: 2 });
    expect(seen[1].retryNote).toContain("@mention");
    expect(seen[1].retryNote).toContain("exactly as written");
    // The note does not quote the handle (the source is untrusted text).
    expect(seen[1].retryNote).not.toContain("hana");
  });

  it("flags the translation as a strong preservation failure when the second one loses the mention too (it is still shown)", async () => {
    const seen: TranslationRequest[] = [];
    const out = await translateChecked(engine(["Hana, please check.", "Hana, check."], seen), req);
    expect(out).toMatchObject({ text: "Hana, check.", flags: [FLAG_QUALITY_MISMATCH], attempts: 2 });
  });

  it("does one call when the mention is kept; the fake engine keeps it", async () => {
    const seen: TranslationRequest[] = [];
    expect(await translateChecked(engine(["@hana please check this."], seen), req)).toMatchObject({ attempts: 1, flags: [] });
    const fake = await translateChecked(createFakeEngine(), req);
    expect(fake).toMatchObject({ attempts: 1, flags: [] });
    expect(fake.text).toContain("@hana");
  });

  it("asks for nothing about mentions when the source has none", async () => {
    const seen: TranslationRequest[] = [];
    const out = await translateChecked(engine(["Hello"], seen), { text: "こんにちは", from: "ja", to: "en" });
    expect(out.attempts).toBe(1);
  });
});

describe("the near-copy detector and the plain-text excerpts are not confused by mentions", () => {
  // Names with lower case letters only (a word with a digit or an upper case start is already not counted as content).
  const names = ["@alice", "@bobby", "@carolina", "@daniel", "@emily", "@francis"].join(" ");
  const resolved = { mentions: names.split(" ") };

  it("a post that is almost only names is not an untranslated copy of itself, and names do not make a real translation look like a copy", async () => {
    // Only mentions (and a short word): the exact copy check would have counted the letters of the names as content.
    expect((await detectCopy(`${names} ありがとう`, `${names} thank you`, "ja", "en", resolved))).toEqual({ copy: false });
    expect((await detectCopy(`${names} ありがとう`, `${names} ありがとう`, "ja", "en", resolved))).toEqual({ copy: false });
    // A long post with names around it is still found when it comes back as it was.
    const long = `${names} これは長い文章で、翻訳されるべき内容がたくさん含まれています。もう少し続きます。さらに続きます。`;
    expect((await detectCopy(long, long, "ja", "en", resolved))).toMatchObject({ copy: true, reason: "identical" });
    // A real translation that keeps the names: not a copy.
    expect((await detectCopy(long, `${names} This is a long text with a lot of content that should be translated. It goes on a little more. And a little more.`, "ja", "en", resolved))).toEqual({ copy: false });
    expect(FLAG_UNTRANSLATED).toBeTruthy();
  });

  it("detects copied Japanese prose after a resolved or unresolved candidate and propagates resolved names through translation checks", async () => {
    const text = "@hanaこの文章は翻訳されるべき重要な日本語の説明内容です";
    for (const mentions of [[], ["@hana"]]) {
      expect((await detectCopy(text, text, "ja", "en", { mentions }))).toMatchObject({ copy: true, reason: "identical" });
    }
    const nameText = `${names} ありがとう`;
    const out = await translateChecked({
      id: "fake", model: "fake",
      async translate() { return { text: nameText, model: "fake", promptVersion: PROMPT_VERSION, inputTokens: 1, outputTokens: 1 }; },
    }, { text: nameText, from: "ja", to: "en", ...resolved });
    expect(out).toMatchObject({ attempts: 1, flags: [] });
  });

  it("excerpts keep the mention as plain text", async () => {
    expect((await markdownToPlainText("**Hi** @hana, see [this](https://example.com/@hana) and `@ben`."))).toBe("Hi @hana, see this and @ben.");
    expect((await plainExcerpt("@hana ＠ben a@b.com", 80))).toBe("@hana ＠ben a@b.com");
  });
});

describe("the translation job", () => {
  const t0 = new Date("2026-10-05T00:00:00Z");


  async function setup() {
    const db = await createTestDb();
    for (const handle of ["alice", "bob", "carol"]) await addMember(db, handle, handle, { readLangs: ["ja", "en"] });
    return db;
  }
  const record = (reqs: TranslationRequest[], text: (r: TranslationRequest) => string): TranslationEngine => ({
    id: "fake",
    model: "fake-1",
    async translate(r) {
      reqs.push(r);
      return { text: text(r), model: "fake-1", promptVersion: PROMPT_VERSION, inputTokens: 1, outputTokens: 1 };
    },
  });
  async function run(db: Db, primary: TranslationEngine) {
    const handlers = createTranslationHandlers({ llm: { engines: { primary, secondary: createFakeEngine(), judge: createFakeJudge() }, env: {} } });
    return runDueJobs(db, handlers, { now: t0, logger: quiet, limit: 500 });
  }

  it("hands the mentions of the source body (the members it names, as written, quoted ones too) to the engine, for the body and not for the title", async () => {
    const db = await setup();
    const topic = await createTopic(db, "alice", { lang: "ja", title: "題 @bob", body: "> @carol が言った\n\n＠Bob さん、@nobody、`@carol` は?" });
    if (!topic.ok) throw new Error("topic failed");
    const reqs: TranslationRequest[] = [];
    await run(db, record(reqs, (r) => `[${r.to}] ${r.text}`));
    const body = reqs.filter((r) => r.text.includes("が言った"));
    expect(body.length).toBeGreaterThan(0);
    for (const r of body) expect(r.mentions).toEqual(["@carol", "＠Bob"]);
    const title = reqs.filter((r) => r.text === "題 @bob");
    expect(title.length).toBeGreaterThan(0);
    for (const r of title) expect(r.mentions).toBeUndefined();
  });

  it("sends no mentions when the body has none, and retries a translation that drops a mention (one retry, then the flag)", async () => {
    const db = await setup();
    const plain = await createTopic(db, "alice", { lang: "ja", title: "t", body: "ただの本文。" });
    const mentioned = await createReply(db, "bob", plain.ok ? plain.id : 0, { lang: "ja", body: "@alice 見てください。" });
    if (!plain.ok || !mentioned.ok) throw new Error("post failed");
    const reqs: TranslationRequest[] = [];
    // The engine drops the mention every time.
    await run(db, record(reqs, (r) => `[${r.to}] ${r.text.replace(/[@＠]\w+/g, "someone")}`));
    expect(reqs.filter((r) => r.text === "ただの本文。").every((r) => r.mentions === undefined)).toBe(true);
    const forReply = reqs.filter((r) => r.text.includes("見てください"));
    // 8 languages, two calls each: the first and the retry (with a note).
    expect(forReply.length).toBe(16);
    expect(forReply.filter((r) => r.retryNote !== undefined)).toHaveLength(8);
    const [row] = await db.select().from(translations).where(and(eq(translations.entryId, mentioned.id), eq(translations.lang, "en"), eq(translations.field, "body")));
    expect(row.flags).toContain(FLAG_QUALITY_MISMATCH);
    expect(row.promptVersion).toBe(PROMPT_VERSION);
  });

  it("renders the translation with the members of the source only: a handle that only the translation has is not emphasized", async () => {
    const db = await setup();
    const topic = await createTopic(db, "alice", { lang: "ja", title: "t", body: "@bob さん、お願いします。" });
    if (!topic.ok) throw new Error("topic failed");
    await run(db, record([], (r) => `[${r.to}] ${r.text} @carol`));
    const [bob] = await db.select({ publicId: profiles.publicId }).from(profiles).where(eq(profiles.userId, "bob"));
    const bobLink = `<a class="mention" href="/u/id/${bob.publicId}">@bob</a>`;
    const [row] = await db.select().from(translations).where(and(eq(translations.entryId, topic.id), eq(translations.lang, "en"), eq(translations.field, "body")));
    expect(row.html).toContain(bobLink);
    expect(row.html).not.toMatch(/class="mention"[^>]*>@carol<\/a>/);
    expect(row.html).toContain("@carol");
    // The same for a translation that is rendered on read.
    await db.update(translations).set({ html: null, htmlVersion: 0 }).where(eq(translations.id, row.id));
    const { entries } = await import("~/lib/db/schema");
    const [e] = await db.select({ h: entries.sourceHash }).from(entries).where(eq(entries.id, topic.id));
    const shown = (await loadEntryDisplays(db, [{ id: topic.id, kind: "topic", lang: "ja", sourceHash: e.h }], { readLangs: ["ja"], displayLang: "en" })).get(topic.id)?.translation?.html ?? "";
    expect(shown).toContain(bobLink);
    expect(shown).not.toMatch(/class="mention"[^>]*>@carol<\/a>/);
  });
});
