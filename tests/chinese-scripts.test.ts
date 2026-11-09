import { messageText } from "~/lib/i18n/messages";
import fs from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createTopic } from "~/lib/entries.server";
import { jobs, translations } from "~/lib/db/schema";
import { createTranslationHandlers } from "~/lib/jobs/translation-jobs.server";
import { runDueJobs } from "~/lib/jobs/queue.server";
import { LANG_LABELS, languageName, LANGS } from "~/lib/languages";
import { TARGET_LANG_SPECS, targetLangSpec } from "~/lib/llm/lang-specs";
import { buildTranslationPrompt, PROMPT_VERSION, translationSystemPrompt } from "~/lib/llm/prompt.server";
import type { TranslationEngine, TranslationRequest } from "~/lib/llm/types";
import { loader as guideLoader } from "~/routes/llms-txt";
import { systemPrompt } from "~/lib/i18n/translate-messages.server";
import { glossaryFor } from "~/lib/i18n/ui-glossary";
import { addMember, createTestDb } from "./helpers/db";

const GET_GUIDE_FOR_TEST = async (p: string) =>
  (await ((await guideLoader({ request: new Request(`http://localhost:5173${p}`), params: {}, context: {} } as never)) as Awaited<Promise<Response>>)).text();

// Name Chinese by script. Translate Simplified using mainland vocabulary and notation, Traditional using Taiwan conventions, not just script conversion.
// Post-translation and UI-translation prompts share the same TARGET_LANG_SPECS instructions.

describe("the target-language instruction (TARGET_LANG_SPECS)", () => {
  it("says Traditional characters with Taiwan vocabulary and orthography for zh-Hant, and not a script conversion", () => {
    const spec = TARGET_LANG_SPECS["zh-Hant"]!;
    expect(spec).toMatch(/Traditional Chinese characters/);
    expect(spec).toMatch(/Taiwan/);
    expect(spec).toMatch(/vocabulary, usage and orthography/);
    expect(spec).toMatch(/not a script conversion/);
    expect(spec).toMatch(/not a character-by-character conversion/);
    expect(spec).toContain("軟體");
    expect(spec).toMatch(/never leave Simplified characters/);
  });

  it("says Simplified characters with mainland China vocabulary and orthography for zh-Hans, and not a script conversion", () => {
    const spec = TARGET_LANG_SPECS["zh-Hans"]!;
    expect(spec).toMatch(/Simplified Chinese characters/);
    expect(spec).toMatch(/mainland China/);
    expect(spec).toMatch(/vocabulary, usage and orthography/);
    expect(spec).toMatch(/not a script conversion/);
    expect(spec).toMatch(/not a character-by-character conversion/);
    expect(spec).toContain("软件");
    expect(spec).toMatch(/never leave Traditional characters/);
  });

  it("covers every supported language and names Chinese by script", () => {
    expect(Object.keys(TARGET_LANG_SPECS).sort()).toEqual([...LANGS].sort());
    expect(targetLangSpec("fr")).toContain("guillemets");
    for (const spec of Object.values(TARGET_LANG_SPECS)) expect(spec).not.toMatch(/zh-CN|zh-TW/);
  });
});

describe("the prompt of a post translation", () => {
  it("keeps entry and interface translation independent of a fixed subject area", () => {
    for (const to of LANGS) {
      expect(translationSystemPrompt("ja", to)).not.toContain("about AI safety");
      expect(systemPrompt(to, [])).not.toContain("about AI safety");
    }
  });

  it("puts the target language instructions in the system prompt", () => {
    for (const to of ["zh-Hant", "zh-Hans"] as const) {
      const system = translationSystemPrompt("ja", to);
      expect(system).toContain(`Target language: ${TARGET_LANG_SPECS[to]}`);
      expect(system).toContain(`into ${to === "zh-Hant" ? "Traditional" : "Simplified"} Chinese`);
    }
    for (const to of LANGS) expect(translationSystemPrompt("ko", to)).toContain(`Target language: ${TARGET_LANG_SPECS[to]}`);
    // Also included in nonce-bearing prompts.
    expect(buildTranslationPrompt({ text: "x", from: "ja", to: "zh-Hant" }).system).toContain("Taiwan");
  });

  it("is prompt version translate-v4 or later", () => {
    expect(Number(PROMPT_VERSION.replace("translate-v", ""))).toBeGreaterThanOrEqual(4);
  });
});

describe("the prompt of the UI strings (pnpm i18n:translate)", () => {
  it("uses the same sentences for zh-Hant and zh-Hans, and keeps the style lines of the other languages", () => {
    for (const locale of ["zh-Hant", "zh-Hans"] as const) {
      expect(systemPrompt(locale, glossaryFor(locale))).toContain(TARGET_LANG_SPECS[locale]!);
    }
    expect(systemPrompt("fr", glossaryFor("fr"))).toContain("vous");
    // Instructions for one script do not enter the other script's prompt.
    expect(systemPrompt("zh-Hant", glossaryFor("zh-Hant"))).not.toContain(TARGET_LANG_SPECS["zh-Hans"]!);
    expect(systemPrompt("zh-Hans", glossaryFor("zh-Hans"))).not.toContain(TARGET_LANG_SPECS["zh-Hant"]!);
  });
});

describe("names of the languages", () => {
  it("are given by script in the choice lists (autonyms)", () => {
    expect(LANG_LABELS["zh-Hans"]).toBe("简体中文");
    expect(LANG_LABELS["zh-Hant"]).toBe("繁體中文");
  });

  it("are given by script in the reader's language, from the BCP 47 tag as it is (Intl.DisplayNames)", () => {
    expect(languageName("zh-Hans", "ja")).toMatch(/簡体字/);
    expect(languageName("zh-Hant", "ja")).toMatch(/繁体字/);
    expect(languageName("zh-Hans", "en")).toBe("Chinese (Simplified)");
    expect(languageName("zh-Hant", "en")).toBe("Chinese (Traditional)");
    expect(languageName("zh-Hans", "fr")).toMatch(/simplifié/);
    expect(languageName("zh-Hant", "fr")).toMatch(/traditionnel/);
    // Do not name the scripts after countries or regions.
    for (const locale of ["ja", "en", "fr", "de", "ko", "th", "vi", "zh-Hans", "zh-Hant"]) {
      for (const lang of LANGS) expect(languageName(lang, locale), `${lang} in ${locale}`).not.toMatch(/台湾|台灣|大陸|大陆|中国大陸|Taiwan|mainland|China\b|Chine\b/i);
    }
  });
});

describe("no language is called by a country or a region", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const names = /\b(zh-CN|zh-TW|zh-HK|zh_CN|zh_TW)\b|台湾語|台湾中国語|中国大陸の中国語|中国大陸語|Taiwanese Chinese|Mainland Chinese/;

  it("does not appear in the English and Japanese messages", () => {
    for (const locale of ["en", "ja"]) {
      const messages = JSON.parse(fs.readFileSync(path.join(root, "messages", `${locale}.json`), "utf8")) as Record<string, string>;
      for (const [key, text] of Object.entries(messages)) expect(messageText(text), `${locale}/${key}`).not.toMatch(names);
    }
  });

  it("does not appear in /llms.txt, which names the two scripts instead", async () => {
    const text = await GET_GUIDE_FOR_TEST("/llms.txt");
    expect(text).not.toMatch(names);
    expect(text).toMatch(/Chinese is two languages, named by script and never by country/);
    expect(text).toContain("`zh-Hans` is Simplified Chinese");
    expect(text).toContain("`zh-Hant` is Traditional Chinese");
    const help = await GET_GUIDE_FOR_TEST("/help/ai.md");
    expect(help).not.toMatch(names);
    expect(help).toMatch(/Chinese is two languages, named by script/);
  });
});

describe("Simplified and Traditional are translated into each other", () => {
  it("queues a job for the other script, and the prompt of that job carries the target script's instruction", async () => {
    const db = await createTestDb();
    await addMember(db, "u1", "wang", { readLangs: ["zh-Hans"] });
    const made = await createTopic(db, "u1", { lang: "zh-Hans", title: "软件的安全", body: "这是一个关于网络和软件的帖子。" });
    if (!made.ok) throw new Error("topic failed");
    const queued = (await db.select().from(jobs).where(eq(jobs.kind, "translate_entry"))).map((j) => (j.payload as { lang: string }).lang);
    expect(queued).toContain("zh-Hant");
    expect(queued).not.toContain("zh-Hans");

    const seen: TranslationRequest[] = [];
    const engine: TranslationEngine = {
      id: "fake",
      model: "fake-1",
      async translate(req) {
        seen.push(req);
        return { text: req.to === "zh-Hant" ? (req.text === "软件的安全" ? "軟體的安全" : "這是一篇關於網路和軟體的貼文。") : `[${req.to}] ${req.text}`, model: "fake-1", promptVersion: PROMPT_VERSION, inputTokens: 5, outputTokens: 5 };
      },
    };
    await runDueJobs(db, createTranslationHandlers({ llm: { engines: { primary: engine, secondary: null, judge: null }, env: {} } }), {
      now: new Date("2026-10-05T00:00:00Z"),
      logger: { error() {}, warn() {} },
      limit: 500,
    });
    // Simplified-to-Traditional is a translation too: exempt from looksUntranslated, with a translation row created.
    const rows = await db.select().from(translations).where(and(eq(translations.entryId, made.id), eq(translations.lang, "zh-Hant")));
    expect(rows.map((r) => [r.field, r.kind, r.text, r.promptVersion])).toEqual(
      expect.arrayContaining([["title", "primary", "軟體的安全", PROMPT_VERSION], ["body", "primary", "這是一篇關於網路和軟體的貼文。", PROMPT_VERSION]]),
    );
    const toHant = seen.filter((r) => r.to === "zh-Hant");
    expect(toHant).toHaveLength(3);
    expect(toHant.every((r) => r.from === "zh-Hans")).toBe(true);
    expect(buildTranslationPrompt(toHant[0]).system).toContain(`Target language: ${TARGET_LANG_SPECS["zh-Hant"]}`);
  });

  it("is also done the other way, from Traditional to Simplified", async () => {
    const db = await createTestDb();
    await addMember(db, "u1", "lin", { readLangs: ["zh-Hant"] });
    const made = await createTopic(db, "u1", { lang: "zh-Hant", title: "軟體", body: "網路上的軟體。" });
    if (!made.ok) throw new Error("topic failed");
    const queued = (await db.select().from(jobs).where(eq(jobs.kind, "translate_entry"))).map((j) => (j.payload as { lang: string }).lang);
    expect(queued).toContain("zh-Hans");
    expect(queued).not.toContain("zh-Hant");
  });
});
