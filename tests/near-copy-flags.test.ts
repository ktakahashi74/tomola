import { quietLogger as quiet } from "./helpers/logger";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "~/lib/db/client.server";
import { jobs, translations } from "~/lib/db/schema";
import { createTopic } from "~/lib/entries.server";
import { listFlaggedTranslations } from "~/lib/flagged-translations.server";
import { pickTranslation } from "~/lib/display";
import { createTranslationHandlers } from "~/lib/jobs/translation-jobs.server";
import { runDueJobs } from "~/lib/jobs/queue.server";
import { PROMPT_VERSION } from "~/lib/llm/prompt.server";
import type { TranslationEngine } from "~/lib/llm/types";
import { requeueTranslations } from "~/lib/translations-requeue.server";
import { addMember, createTestDb } from "./helpers/db";

// A near-copy flag (untranslated_script, untranslated_similar) can be a wrong call, so the translation stays visible with its machine-translation label, the flag is recorded and
// listed for the operators, and translations:requeue does not run the same result again unless it is asked to (--include-flagged). An exact copy still hides the translation.

const t0 = new Date("2026-10-05T00:00:00Z");

const BODY = "これは、四十字を超える、ごく普通の日本語の文章です。テストのために、少し長めに書いています。さらに、もう一文を足しておきます。";

// A real-looking engine (not "fake": the fake engine is exempt from the near-copy check) that returns whatever the test says.
function engineReturning(textFor: (req: { text: string; to: string }) => string): TranslationEngine {
  return {
    id: "gemini",
    model: "test-model",
    async translate(req) {
      return { text: textFor(req), model: "test-model", promptVersion: PROMPT_VERSION, inputTokens: 10, outputTokens: 10 };
    },
  };
}
// A real translation in the script of each target language (long enough to pass the length check against the Japanese body).
const SAMPLES: Record<string, string> = {
  en: "This is an ordinary Japanese text that is longer than forty characters, written a little long for the test, and one more sentence is added.",
  fr: "Ceci est un texte japonais ordinaire de plus de quarante caractères, écrit un peu long pour le test, avec une phrase de plus.",
  de: "Dies ist ein gewöhnlicher japanischer Text mit mehr als vierzig Zeichen, für den Test etwas länger geschrieben, mit einem weiteren Satz.",
  vi: "Đây là một đoạn văn tiếng Nhật bình thường dài hơn bốn mươi ký tự, được viết hơi dài cho bài kiểm tra, và thêm một câu nữa.",
  "zh-Hans": "这是一段普通的日语文章，超过四十个字，为了测试而写得稍微长一些，另外再加上一句话。",
  "zh-Hant": "這是一段普通的日語文章，超過四十個字，為了測試而寫得稍微長一些，另外再加上一句話。",
  ko: "이것은 사십 자를 넘는 평범한 일본어 문장입니다. 테스트를 위해 조금 길게 썼습니다. 한 문장을 더 덧붙여 둡니다.",
  th: "นี่คือข้อความภาษาญี่ปุ่นทั่วไปที่ยาวกว่าสี่สิบตัวอักษร เขียนให้ยาวขึ้นเล็กน้อยเพื่อการทดสอบ และเพิ่มอีกหนึ่งประโยค",
};
const good = (req: { text: string; to: string }) => (req.text === BODY ? SAMPLES[req.to] : `[${req.to}] ${req.text}`);
const run = (db: Db, engine: TranslationEngine) =>
  runDueJobs(db, createTranslationHandlers({ llm: { engines: { primary: engine, secondary: null, judge: null }, env: {} } }), { now: t0, logger: quiet, limit: 1000 });

async function setup() {
  const db = await createTestDb();
  await addMember(db, "u1", "hana");
  const topic = await createTopic(db, "u1", { lang: "ja", title: "題", body: BODY });
  if (!topic.ok) throw new Error("topic failed");
  return { db, topicId: topic.id };
}
const bodyRow = async (db: Db, entryId: number, lang: string) => {
  const [row] = await db.select().from(translations).where(and(eq(translations.entryId, entryId), eq(translations.lang, lang), eq(translations.field, "body"), eq(translations.kind, "primary")));
  return row;
};

describe("a near-copy flag does not hide the translation", () => {
  it("saves the flag, keeps the translation shown, lists it, and requeue skips it unless --include-flagged", async () => {
    const { db, topicId } = await setup();
    // the body comes back almost unchanged in every language (one character differs)
    await run(db, engineReturning((req) => (req.text === BODY ? BODY.replace("四十字", "四十文字") : good(req))));
    const en = await bodyRow(db, topicId, "en");
    expect(en.flags.some((f) => f === "untranslated_script" || f === "untranslated_similar")).toBe(true);
    expect(en.flags).not.toContain("untranslated");
    // readers still get it, as a machine translation (a hidden flag would give null: "waiting for translation")
    expect(pickTranslation([en], en.sourceHash)).toMatchObject({ kind: "primary", text: en.text });
    // the operators' list shows it, with the flag
    const listed = await listFlaggedTranslations(db);
    expect(listed.length).toBeGreaterThanOrEqual(8);
    expect(listed.find((f) => f.lang === "en" && f.field === "body")).toMatchObject({ entryId: topicId, kind: "topic", threadId: topicId, flags: en.flags });
    // requeue leaves it alone, so the same result is not billed and flagged forever
    await db.update(jobs).set({ status: "done" });
    expect(await requeueTranslations(db)).toMatchObject({ translate: 0 });
    // --include-flagged queues the flagged ones, and the job translates them again even though the current row is usable
    const again = await requeueTranslations(db, { includeFlagged: true });
    expect(again.translate).toBeGreaterThanOrEqual(8);
    expect(await run(db, engineReturning(good))).toMatchObject({ failed: 0 });
    const fixed = await bodyRow(db, topicId, "en");
    expect(fixed.text).toBe(SAMPLES.en);
    expect(fixed.flags).toEqual([]);
    expect(await listFlaggedTranslations(db)).toHaveLength(0);
  });

  it("an exact copy still hides the translation, and requeue queues it again", async () => {
    const { db, topicId } = await setup();
    await run(db, engineReturning((req) => (req.text === BODY ? BODY : good(req))));
    const en = await bodyRow(db, topicId, "en");
    expect(en.flags).toEqual(["untranslated"]);
    expect(pickTranslation([en], en.sourceHash)).toBeNull();
    expect((await listFlaggedTranslations(db)).some((f) => f.lang === "en" && f.flags.includes("untranslated"))).toBe(true);
    await db.update(jobs).set({ status: "done" });
    expect((await requeueTranslations(db)).translate).toBeGreaterThanOrEqual(8);
  });

  it("does not list a translation of a hidden or edited-away version, and ignores other flags such as judged", async () => {
    const { db, topicId } = await setup();
    await run(db, engineReturning(good));
    expect(await listFlaggedTranslations(db)).toHaveLength(0);
    await db.update(translations).set({ flags: ["judged"] }).where(eq(translations.entryId, topicId));
    expect(await listFlaggedTranslations(db)).toHaveLength(0);
    await db.update(translations).set({ flags: ["structure_mismatch"], sourceHash: "an old version" }).where(and(eq(translations.entryId, topicId), eq(translations.lang, "en")));
    expect(await listFlaggedTranslations(db)).toHaveLength(0);
  });
});
