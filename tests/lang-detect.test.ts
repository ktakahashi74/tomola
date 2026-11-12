import { afterEach, describe, expect, it, vi } from "vitest";
import { detectLang } from "~/lib/lang-detect.core.server";
import { applyPastedFrontmatter } from "~/lib/entry-form.server";

afterEach(() => vi.unstubAllEnvs());
const sentences = {
  ja: "この仕組みは私たちの議論を支えます。違う考えを持つ人も参加してください。",
  en: "This is a place for people to share their ideas and to learn from each other.",
  fr: "Nous avons une place pour les personnes qui veulent partager leurs idées avec les autres.",
  de: "Wir haben einen Ort für die Menschen, die ihre Ideen mit anderen teilen und von ihnen lernen.",
  "zh-Hans": "我们在这个地方讨论不同的观点，请大家分享自己的学习经验和对未来的想法。",
  "zh-Hant": "我們在這個地方討論不同的觀點，請大家分享自己的學習經驗和對未來的想法。",
  ko: "우리는 서로 다른 생각을 가진 사람들과 함께 이야기하고 배우는 공간을 만들고 있습니다.",
  th: "เราต้องการสร้างพื้นที่สำหรับทุกคนเพื่อแบ่งปันความคิดและเรียนรู้จากกันและกัน",
  vi: "Chúng tôi muốn tạo một nơi để mọi người chia sẻ ý tưởng và học hỏi từ nhau.",
} as const;

describe("prose language detection", () => {
  const hintedCases: (readonly [text: string, hint: string, lang: string | null])[] = [
    ...["確認", "時間変更", "時間変更OK", "会議室A", "開始", "学会", "国会", "会議延期", "了解", "確認確認確認確認確認確認"].map(text => [text, "ja", "ja"] as const),
    ...["确认", "会议延期", "谢谢"].map(text => [text, "zh-Hans", "zh-Hans"] as const),
    ...["確認", "謝謝"].map(text => [text, "zh-Hant", "zh-Hant"] as const),
    [sentences["zh-Hans"], "ja", "zh-Hans"],
    [sentences["zh-Hant"], "ja", "zh-Hant"],
    [sentences["zh-Hans"], "zh-Hant", "zh-Hans"],
    ["確認", "en", "zh-Hant"],
    ["学会", "en", "zh-Hans"],
    ["会議延期", "en", null],
    ["こんにちは", "zh-Hans", "ja"],
  ];
  it.each(hintedCases)("uses hint %s / %s only for ambiguous Han prose", (text, hint, lang) => {
    expect(detectLang(text, hint)).toBe(lang);
  });
  it("preserves unhinted and non-CJK-hinted detection", () => {
    for (const text of [...Object.values(sentences), "確認", "学会", "時間変更OK", "会議室A", "山川水土木日月", "確認 API"]) {
      expect(detectLang(text, "en")).toBe(detectLang(text));
    }
    expect(detectLang("確認 API", "ja")).toBe(detectLang("確認 API"));
  });
  it.each([
    ["Il faut être prudent : même si les idées sont différentes, nous pouvons parler avec les autres.", "fr"],
    ["We discuss the idea of もったいない and how it can change the way we use our resources.", "en"],
    ["> この仕組みは日本語で説明されています。\n\nThis is a place for people to share their ideas and to learn from each other.", "en"],
    ["> この仕組みは日本語で説明されています。\n引用の続きも判定から除きます。\n\nThis is a place for people to share their ideas and to learn from each other.", "en"],
    ["> この仕組みは日本語で説明されています。", null],
  ])("uses the writer's prose in %s", async (text, lang) => expect(await detectLang(text!)).toBe(lang));
  for (const [lang, text] of Object.entries(sentences)) {
    it(`detects ${lang} with ordinary prose, English terminology and mostly code`, async () => {
      expect((await detectLang(text))).toBe(lang);
      expect((await detectLang(`${text} API JSON`))).toBe(lang);
      expect((await detectLang(`\`the of to in and\` $the + of$ https://example.org/the/of/to @the\n${text}\n\`\`\`ts\n${"the of to in and ".repeat(100)}\n\`\`\``))).toBe(lang);
      expect((await detectLang(text.normalize("NFD")))).toBe(lang);
    });
  }
  it.each([
    ["こんにちは", "ja"], ["안녕하세요", "ko"], ["สวัสดี", "th"], ["学习汉语", "zh-Hans"], ["學習漢語", "zh-Hant"],
    ["The cat is here.", null], ["Nous sommes ici.", null], ["Das ist gut.", null], ["Xin chào.", null],
  ])("handles a short text %s conservatively", async (text, lang) => expect((await detectLang(text))).toBe(lang));
  it("keeps an English sentence with a French name in English", async () => {
    expect((await detectLang("We are here to discuss the work of François with our friends and their colleagues."))).toBe("en");
  });
  it.each(["", "12345", "Jean François Müller Nguyễn", "RTX1300 ABC2500 XYZ700", "山川水土木日月", "我们我們", "the de der", "the the the", "@the @and @with @from", "`the cat is here and it is at home`", "$$the cat is here and it is at home$$"])('does not guess from "%s"', async text => {
    expect((await detectLang(text))).toBeNull();
  });
});

describe("entry language resolution", () => {
  const raw = (body: string, lang = "") => ({ title: "", body, lang, asksStance: false, altOf: null, stanceTag: null });
  it("passes the member default through the worker for short Han posts", async () => {
    for (const body of ["確認", "時間変更", "時間変更OK", "会議室A", "開始", "学会", "国会"]) {
      expect(await applyPastedFrontmatter(raw(body), "topic", { defaultLang: "ja" })).toMatchObject({ ok: true, input: { lang: "ja" }, language: { detected: "ja" } });
    }
  });
  it("detects enabled prose for topics and replies instead of the member default", async () => {
    vi.stubEnv("ENABLED_LANGS", "ja,en");
    for (const kind of ["topic", "reply"] as const) expect((await applyPastedFrontmatter(raw(sentences.en), kind, { defaultLang: "ja" }))).toMatchObject({ ok: true, input: { lang: "en" }, language: { source: "detected", detected: "en" } });
  });
  it("falls back for disabled or inconclusive prose, retaining the detection for the notice", async () => {
    vi.stubEnv("ENABLED_LANGS", "ja,en");
    expect((await applyPastedFrontmatter(raw(sentences.fr), "topic", { defaultLang: "ja" }))).toMatchObject({ ok: true, input: { lang: "ja" }, language: { source: "default", detected: "fr" } });
    expect((await applyPastedFrontmatter(raw("ABC2500"), "topic", { defaultLang: "ja" }))).toMatchObject({ ok: true, language: { source: "default", detected: null } });
  });
  it("detects only the frontmatter-free body, preserving explicit form and frontmatter language", async () => {
    const body = `---\ntitle: 日本語の題\n---\n${sentences.en}`;
    expect((await applyPastedFrontmatter(raw(body), "topic", { defaultLang: "ja" }))).toMatchObject({ ok: true, input: { body: sentences.en, lang: "en" }, language: { source: "detected", detected: "en" } });
    expect((await applyPastedFrontmatter(raw(`---\nlang: ja\n---\n${sentences.en}`), "topic", { defaultLang: "en" }))).toMatchObject({ ok: true, input: { lang: "ja" }, language: { source: "explicit", detected: "en" } });
    expect((await applyPastedFrontmatter(raw(`---\nlang: fr\n---\n${sentences.en}`, "ja"), "topic", { defaultLang: "en" }))).toMatchObject({ ok: true, input: { lang: "ja" }, language: { source: "explicit", detected: "en" } });
  });
});
