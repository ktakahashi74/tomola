import { describe, expect, it } from "vitest";
import { bigramDice, contentLetters, detectCopy, NEAR_MIN_CONTENT_LETTERS } from "~/lib/llm/copy-detection.server";
import { proseOf } from "~/lib/llm/structure.server";
import { looksUntranslated, translateChecked } from "~/lib/llm/translate.server";
import { HIDDEN_PRIMARY_FLAGS } from "~/lib/llm/flags";
import type { Lang } from "~/lib/languages";
import type { TranslationEngine, TranslationRequest } from "~/lib/llm/types";

// Detect untranslated copies or near-copies; table cases contrast valid translations with untranslated outputs.

const zhHant =
  "這個討論串想問的是，可解釋性研究到底能不能協助我們發現模型在訓練過程中學到的欺騙行為。我認為目前的證據還不夠，但是方向值得繼續探索。另外，評估的方法本身也需要被檢討，否則我們很容易誤判進度。";
const zhHantAsJa =
  "このスレッドが問いたいのは、可解釈性研究が、モデルが訓練中に学んだ欺瞞的な行動を見つける助けになるのかということだ。現時点の証拠は十分ではないと思うが、方向性は探る価値がある。また、評価の方法そのものも見直す必要があり、さもなければ進捗を誤って判断しやすい。";
// Traditional Chinese returned unchanged except glossary terms replaced with Japanese, observed in an actual run on 2026-10-01.
const zhHantCopiedWithOneTerm = zhHant.replace("可解釋性", "解釈可能性");

const en =
  "I think the evidence for this is still thin, but the direction seems worth exploring. We should also review how progress is measured, otherwise it is easy to fool ourselves about what the models can actually do.";
const enAsJa =
  "この点の証拠はまだ薄いと思うが、方向性は探る価値がありそうだ。進捗の測り方も見直すべきだ。そうしないと、モデルが実際に何をできるのかについて、自分たちを欺いてしまいやすい。";
const enAsFr =
  "Je pense que les preuves à ce sujet sont encore minces, mais la direction semble mériter d'être explorée. Nous devrions aussi revoir la façon dont les progrès sont mesurés, sinon il est facile de se tromper sur ce que les modèles peuvent réellement faire.";
const enAsDe =
  "Ich denke, die Belege dafür sind noch dünn, aber die Richtung scheint es wert zu sein, sie zu erkunden. Wir sollten auch überprüfen, wie Fortschritt gemessen wird, sonst täuschen wir uns leicht darüber, was die Modelle tatsächlich können.";
const enNearCopy = en.replace("thin", "weak").replace("easy", "simple");

const ja =
  "この点の証拠はまだ薄いと思うが、方向性は探る価値がありそうだ。進捗の測り方も見直すべきだ。そうしないと、モデルが実際に何をできるのかについて、自分たちを欺いてしまいやすい。";
const jaAsEn =
  "I think the evidence on this point is still thin, but the direction seems worth exploring. We should also review how progress is measured; otherwise it is easy to deceive ourselves about what the models can really do.";
const jaAsZhHans = "我认为这方面的证据还很薄弱，但这个方向似乎值得探索。我们也应该重新审视衡量进展的方法，否则很容易对模型实际能做什么产生错觉。";
const jaNearCopy = ja.replace("そうしないと", "さもないと");

const ko = "이 점에 대한 증거는 아직 얇다고 생각하지만, 방향은 탐구할 가치가 있어 보입니다. 진척을 측정하는 방식도 다시 검토해야 합니다. 그렇지 않으면 모델이 실제로 무엇을 할 수 있는지에 대해 우리 스스로를 속이기 쉽습니다.";
const th = "ฉันคิดว่าหลักฐานในเรื่องนี้ยังบางอยู่ แต่ทิศทางนี้ดูเหมือนคุ้มค่าที่จะสำรวจ เราควรทบทวนวิธีวัดความก้าวหน้าด้วย มิฉะนั้นจะหลอกตัวเองได้ง่ายว่าโมเดลทำอะไรได้จริง";

// A Japanese post that quotes a long English passage: a correct translation keeps the quotation as it is.
const quote = "Reward hacking is the phenomenon in which a trained policy exploits flaws in the specified objective rather than doing what its designers intended.";
const jaWithQuote = `次の一文は、報酬ハッキングの定義としてよく引用される。\n\n> ${quote}\n\nこの定義は、仕様の穴を突く行動を指しており、モデルの悪意を前提にしていないと私は思う。`;
const enWithQuote = `The following sentence is often quoted as the definition of reward hacking.\n\n> ${quote}\n\nI think this definition refers to behavior that exploits holes in the specification, and does not assume malice on the part of the model.`;
const zhWithQuote = `下面这句话常被引用为奖励黑客的定义。\n\n> ${quote}\n\n我认为这个定义指的是钻规范漏洞的行为，并不以模型怀有恶意为前提。`;

// A table of numbers: only the header has words, and the row labels (m1, m2, ...) are identifiers. The numbers are the same in every language.
const numericRows = Array.from({ length: 40 }, (_, i) => `| m${i + 1} | ${(0.5 + i / 100).toFixed(3)} | ${(1.2 - i / 100).toFixed(3)} | ${100 + i} |`).join("\n");
const tableEn = `| model | accuracy | loss | steps |\n| --- | --- | --- | --- |\n${numericRows}`;
const tableFr = `| modèle | précision | perte | pas |\n| --- | --- | --- | --- |\n${numericRows}`;
const tableJa = `| モデル | 精度 | 損失 | ステップ |\n| --- | --- | --- | --- |\n${numericRows}`;
// the same table with lowercase words as row labels, so that it has enough "content" to be judged
const wordRows = Array.from({ length: 12 }, (_, i) => `| run ${"alpha beta gamma delta".split(" ")[i % 4]} | ${(0.5 + i / 100).toFixed(3)} |`).join("\n");

// A sentence made of model names with a few words: the translation keeps the names.
const namesEn = "We compared GPT-4o, Claude 3.5 Sonnet, Gemini 1.5 Pro, Llama 3 70B, Mistral Large 2 and Qwen 2.5 72B under the same conditions.";
const namesJa = "GPT-4o、Claude 3.5 Sonnet、Gemini 1.5 Pro、Llama 3 70B、Mistral Large 2、Qwen 2.5 72B を、同じ条件で比較した。";

// A Chinese list of terms becomes a Japanese list of kanji terms: no kana, no sentence.
const zhHantList = "強化學習\n獎勵設計\n可解釋性\n對齊問題\n存亡風險\n人工智慧治理\n欺騙行為偵測\n模型評估\n能力外推\n紅隊測試";
const jaKanjiList = "強化学習\n報酬設計\n解釈可能性\n整合性問題\n存亡リスク\n人工知能ガバナンス\n欺瞞行動の検知\n模型評価\n能力外挿\n攻撃的検証";

// Half translated: the first half is French, the second half is still English.
const enParagraph =
  "I think the evidence for this is still thin, but the direction seems worth exploring. We should also review how progress is measured, otherwise it is easy to fool ourselves about what the models can actually do. The second paragraph says that the same applies to evaluations of deceptive behavior, which are hard to design and easy to overfit.";
const halfFrench =
  "Je pense que les preuves à ce sujet sont encore minces, mais la direction semble mériter d'être explorée. Nous devrions aussi revoir la façon dont les progrès sont mesurés. The second paragraph says that the same applies to evaluations of deceptive behavior, which are hard to design and easy to overfit.";

type Row = { name: string; source: string; translated: string; from: Lang; to: Lang; copy: boolean; reason?: string };

const rows: Row[] = [
  // Untranslated.
  { name: "zh-Hant to ja, mostly Chinese with one glossary term replaced", source: zhHant, translated: zhHantCopiedWithOneTerm, from: "zh-Hant", to: "ja", copy: true },
  { name: "identical copy", source: en, translated: en, from: "en", to: "ja", copy: true, reason: "identical" },
  { name: "en to ja, English returned with two words changed", source: en, translated: enNearCopy, from: "en", to: "ja", copy: true },
  { name: "en to fr, English returned with two words changed", source: en, translated: enNearCopy, from: "en", to: "fr", copy: true, reason: "similar" },
  { name: "en to de, English returned with two words changed", source: en, translated: enNearCopy, from: "en", to: "de", copy: true, reason: "similar" },
  { name: "ja to zh-Hans, Japanese returned with a phrase changed", source: ja, translated: jaNearCopy, from: "ja", to: "zh-Hans", copy: true, reason: "similar" },
  { name: "ja to en, Japanese returned", source: ja, translated: jaNearCopy, from: "ja", to: "en", copy: true, reason: "script" },
  { name: "ko to en, Korean returned", source: ko, translated: ko.replace("모델", "모형"), from: "ko", to: "en", copy: true, reason: "script" },
  { name: "ja to th, Japanese returned", source: ja, translated: jaNearCopy, from: "ja", to: "th", copy: true, reason: "script" },
  { name: "th to ko, Thai returned", source: th, translated: th, from: "th", to: "ko", copy: true },
  // Valid translation despite similarity.
  { name: "zh-Hant to ja, a real translation", source: zhHant, translated: zhHantAsJa, from: "zh-Hant", to: "ja", copy: false },
  { name: "en to ja, a real translation", source: en, translated: enAsJa, from: "en", to: "ja", copy: false },
  { name: "en to fr, a real translation with many cognates", source: en, translated: enAsFr, from: "en", to: "fr", copy: false },
  { name: "en to de, a real translation", source: en, translated: enAsDe, from: "en", to: "de", copy: false },
  { name: "ja to en, a real translation", source: ja, translated: jaAsEn, from: "ja", to: "en", copy: false },
  { name: "ja to zh-Hans, a real translation (shared kanji)", source: ja, translated: jaAsZhHans, from: "ja", to: "zh-Hans", copy: false },
  { name: "zh-Hans to zh-Hant, an almost identical text is normal", source: zhHantAsJa, translated: zhHantAsJa, from: "zh-Hans", to: "zh-Hant", copy: false },
  { name: "zh-Hant to zh-Hans, a high overlap is normal", source: zhHant, translated: zhHant.replace("這個", "这个").replace("討論串", "讨论串"), from: "zh-Hant", to: "zh-Hans", copy: false },
  { name: "the same language", source: en, translated: en, from: "en", to: "en", copy: false },
  // Short text, names, model numbers, code, formulas and URL-only text.
  { name: "a short title", source: "Reward hacking", translated: "Reward hacking", from: "en", to: "fr", copy: false },
  { name: "only names (copied exactly)", source: "Anthropic, OpenAI, Google DeepMind and Meta", translated: "Anthropic, OpenAI, Google DeepMind and Meta", from: "en", to: "ja", copy: false },
  { name: "names and model numbers with little else", source: "Claude 3.5 Sonnet, GPT-4o, Gemini 1.5 Pro, Llama 3 70B, Mistral Large 2, Qwen 2.5 72B", translated: "Claude 3.5 Sonnet, GPT-4o, Gemini 1.5 Pro, Llama 3 70B, Mistral Large 2, Qwen 2.5 72B", from: "en", to: "zh-Hans", copy: false },
  { name: "names with a few words, a fair translation keeps the names", source: "OpenAI, Anthropic and Google DeepMind each publish a model card", translated: "OpenAI、Anthropic、Google DeepMind はそれぞれモデルカードを公開している", from: "en", to: "ja", copy: false },
  { name: "mostly URLs", source: "See https://example.com/a/very/long/path/to/a/page/with/many/parts and https://example.org/another/long/path/segment", translated: "See https://example.com/a/very/long/path/to/a/page/with/many/parts and https://example.org/another/long/path/segment", from: "en", to: "ja", copy: false },
  { name: "mostly code", source: "```py\nresult = compute_the_reward(policy, environment, seed=42)\nprint(result)\n```\n\n`compute_the_reward`", translated: "```py\nresult = compute_the_reward(policy, environment, seed=42)\nprint(result)\n```\n\n`compute_the_reward`", from: "en", to: "ja", copy: false },
  { name: "mostly a formula", source: "$$\\mathcal{L}(\\theta) = \\mathbb{E}_{x \\sim D}[\\log p_\\theta(x)] + \\lambda \\|\\theta\\|_2^2$$", translated: "$$\\mathcal{L}(\\theta) = \\mathbb{E}_{x \\sim D}[\\log p_\\theta(x)] + \\lambda \\|\\theta\\|_2^2$$", from: "en", to: "ja", copy: false },
  { name: "prose with a formula and code, translated", source: `${en}\n\n$$a^2 + b^2 = c^2$$\n\n\`\`\`py\nx = 1\n\`\`\``, translated: `${enAsJa}\n\n$$a^2 + b^2 = c^2$$\n\n\`\`\`py\nx = 1\n\`\`\``, from: "en", to: "ja", copy: false },
  // Latin letters, digits and quotations that are the same on both sides are not a copy
  { name: "ja post with a long English quotation to en", source: jaWithQuote, translated: enWithQuote, from: "ja", to: "en", copy: false },
  { name: "ja post with a long English quotation to zh-Hans", source: jaWithQuote, translated: zhWithQuote, from: "ja", to: "zh-Hans", copy: false },
  { name: "a 40-row numeric table, en to fr", source: tableEn, translated: tableFr, from: "en", to: "fr", copy: false },
  { name: "a 40-row numeric table, en to ja", source: tableEn, translated: tableJa, from: "en", to: "ja", copy: false },
  { name: "a table with word labels and the same numbers, en to fr (only the numbers are shared)", source: `| item | value |\n| --- | --- |\n${wordRows}`, translated: `| élément | valeur |\n| --- | --- |\n${wordRows.replace(/run alpha/g, "essai alpha").replace(/run beta/g, "essai bêta").replace(/run gamma/g, "essai gamma").replace(/run delta/g, "essai delta")}`, from: "en", to: "fr", copy: false },
  { name: "a sentence of model names, en to ja", source: namesEn, translated: namesJa, from: "en", to: "ja", copy: false },
  { name: "a Chinese list of terms to a Japanese list of kanji terms (no kana, no sentence)", source: zhHantList, translated: jaKanjiList, from: "zh-Hant", to: "ja", copy: false },
  // a kanji list copied as it is is still a copy when it is identical
  { name: "the Chinese list returned unchanged", source: zhHantList, translated: zhHantList, from: "zh-Hant", to: "ja", copy: true, reason: "identical" },
  // known limit: a text that is only partly translated is not found (similarity about 0.5, far below 0.85)
  { name: "half translated, en to fr (not detected: documented limit)", source: enParagraph, translated: halfFrench, from: "en", to: "fr", copy: false },
  { name: "Japanese translation right after a link, no spaces (the URL must not swallow it)", source: en, translated: `[2016年](https://arxiv.org/abs/1705.08807)、そして[2022年](https://example.org/a)の調査はいずれも、${enAsJa}`, from: "en", to: "ja", copy: false },
];

describe("looksUntranslated: exact and near copies", () => {
  it.each(rows)("$name", async ({ source, translated, from, to, copy, reason }) => {
    expect((await looksUntranslated(source, translated, from, to))).toBe(copy);
    if (copy && reason) expect((await detectCopy(source, translated, from, to)).reason).toBe(reason);
  });

  it("keeps the old rules: a short text, 20 letters, whitespace-normalized equality", async () => {
    expect((await looksUntranslated("a".repeat(19), "a".repeat(19), "en", "ja"))).toBe(false);
    expect((await looksUntranslated("a".repeat(20), "a".repeat(20), "en", "ja"))).toBe(true);
    expect((await looksUntranslated(en, `  ${en.replace(" ", "\n ")}  `, "en", "fr"))).toBe(true);
  });
});

describe("translations retaining a few culturally rooted terms", () => {
  const samples: { to: Lang; source: string; translated: string }[] = [
    {
      to: "en",
      source: "偶然同じ町に住むようになった私たちは、縁を感じながら毎週集まって話しています。急いで答えを出すよりも、会話の間を大切にしたいと思います。沈黙の時間にも互いの考えを聞く余地があり、その時間を共有することで、別の見方を少しずつ理解できると感じています。",
      translated: "After finding ourselves living in the same town by chance, we meet every week to talk, feeling a sense of 縁 (en: a bond formed through circumstances). Rather than rushing to an answer, I want to value the 間 (ma: a meaningful pause) in our conversation. Even in silence, there is room to listen to each other's thoughts. Sharing that time feels like a way to understand other perspectives little by little.",
    },
    {
      to: "fr",
      source: "旅先で会った人と今も手紙を交わしている。遠く離れて暮らしていても、その縁は続いている。返事を急がずに待つ間を、互いの暮らしを想像する時間として、大切にしている。",
      translated: "Je continue à échanger des lettres avec une personne rencontrée en voyage. Même si nous vivons loin l'un de l'autre, ce 縁 (en : un lien né des circonstances) se poursuit. Je tiens au 間 (ma : une pause porteuse de sens) pendant lequel nous attendons sans presser la réponse, comme à un moment où nous imaginons la vie de l'autre.",
    },
  ];

  it.each(samples)("does not flag a normal-length $to translation with two inline explanations", async ({ source, translated, to }) => {
    // Exercise both near-copy checks rather than the short-text or fake-engine exemptions.
    expect((await contentLetters((await proseOf(source))))).toBeGreaterThanOrEqual(NEAR_MIN_CONTENT_LETTERS);
    expect((await detectCopy(source, translated, "ja", to))).toEqual({ copy: false });
    const engine: TranslationEngine = {
      id: "gemini",
      model: "test-model",
      async translate() {
        return { text: translated, model: "test-model", promptVersion: "test", inputTokens: 1, outputTokens: 1 };
      },
    };
    const result = await translateChecked(engine, { text: source, from: "ja", to });
    expect(result).toMatchObject({ text: translated, attempts: 1, flags: [] });
  });
});

describe("copy detection helpers", () => {
  it("measures the character-bigram similarity", async () => {
    expect((await bigramDice("abc", "abc"))).toBe(1);
    expect((await bigramDice("abc", "xyz"))).toBe(0);
    expect((await bigramDice("", "abc"))).toBe(0);
    // Ignore case, whitespace and punctuation.
    expect((await bigramDice("Hello, World", "hello world"))).toBe(1);
  });

  it("counts only the letters of words that are not names or identifiers", async () => {
    expect((await contentLetters("Anthropic OpenAI GPT-4o snake_case 123"))).toBe(0);
    expect((await contentLetters("the model is small"))).toBe("themodelissmall".length);
    expect((await contentLetters("日本語の文章です"))).toBe(8);
  });

  it("does not let a URL swallow the Japanese text that follows it without a space", async () => {
    expect((await proseOf("[年](https://example.org/a)の調査は重要")).replace(/\s+/g, "")).toContain("の調査は重要");
    expect((await proseOf("see www.example.org/x and https://e.example/y。")).replace(/\s+/g, " ").trim()).toBe("see and 。");
  });
});

describe("translateChecked with a near copy", () => {
  const req: TranslationRequest = { text: zhHant, from: "zh-Hant", to: "ja" };
  const scripted = (texts: string[], calls: TranslationRequest[] = [], id: TranslationEngine["id"] = "gemini"): TranslationEngine => {
    let i = 0;
    return {
      id,
      model: "fake-1",
      async translate(r) {
        calls.push(r);
        return { text: texts[Math.min(i++, texts.length - 1)], model: "fake-1", promptVersion: "p", inputTokens: 10, outputTokens: 4 };
      },
    };
  };

  it("retries once with a note, and adopts a real translation without flags", async () => {
    const calls: TranslationRequest[] = [];
    const out = await translateChecked(scripted([zhHantCopiedWithOneTerm, zhHantAsJa], calls), req);
    expect(out).toMatchObject({ text: zhHantAsJa, flags: [], attempts: 2 });
    expect(calls[1].retryNote).toMatch(/nearly so|target language/);
  });

  it("flags a near copy that is still there after the retry with the flag of its kind, which does not hide the translation", async () => {
    const script = await translateChecked(scripted([zhHantCopiedWithOneTerm]), req);
    expect(script).toMatchObject({ flags: ["untranslated_script"], attempts: 2 });
    const similar = await translateChecked(scripted([enNearCopy]), { text: en, from: "en", to: "fr" });
    expect(similar).toMatchObject({ flags: ["untranslated_similar"], attempts: 2 });
    // only an exact copy gets the flag that hides the translation
    const identical = await translateChecked(scripted([en]), { text: en, from: "en", to: "fr" });
    expect(identical).toMatchObject({ flags: ["untranslated"], attempts: 2 });
    expect(HIDDEN_PRIMARY_FLAGS).toContain("untranslated");
    expect(HIDDEN_PRIMARY_FLAGS).not.toContain("untranslated_script");
    expect(HIDDEN_PRIMARY_FLAGS).not.toContain("untranslated_similar");
  });

  it("does not judge the fake engine's \"[to] original\" output a near copy (an identical copy would still count)", async () => {
    const body = "これは、四十字を超える、ごく普通の日本語の文章です。テストのために、少し長めに書いています。さらに、もう一文を足しておきます。";
    const calls: TranslationRequest[] = [];
    const out = await translateChecked(scripted([`[en] ${body}`], calls, "fake"), { text: body, from: "ja", to: "en" });
    expect(out).toMatchObject({ flags: [], attempts: 1 });
    // the same output from a real engine is a near copy
    const real = await translateChecked(scripted([`[en] ${body}`], [], "gemini"), { text: body, from: "ja", to: "en" });
    expect(real.flags.length).toBeGreaterThan(0);
    const same = await translateChecked(scripted([body], [], "fake"), { text: body, from: "ja", to: "en" });
    expect(same).toMatchObject({ flags: ["untranslated"], attempts: 2 });
  });

  it("does not retry a real translation of a text that is similar by nature (zh-Hans to zh-Hant)", async () => {
    const out = await translateChecked(scripted([zhHant]), { text: zhHant, from: "zh-Hans", to: "zh-Hant" });
    expect(out).toMatchObject({ flags: [], attempts: 1 });
  });
});
