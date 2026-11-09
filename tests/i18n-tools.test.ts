import { spawnSync } from "node:child_process";
import { invokeI18n, type CliResult } from "./helpers/cli";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ALL_LOCALES,
  checkMessages,
  KEEP_TERMS,
  mergeMessages,
  replaceMessages,
  missingKeys,
  placeholders,
  TARGET_LOCALES,
  validateMessage,
} from "~/lib/i18n/messages";
import { checkStale, fingerprint, initialHashes, parseHashes, serializeHashes, stamp, staleKeys, HASH_LENGTH } from "~/lib/i18n/source-hashes";
import { dropStaleFiles, keysToTranslate as keysToTranslateForTest, translateFiles } from "~/lib/i18n/files.server";
import { FatalTranslationError, parseResponse, systemPrompt, translateMessages, type Complete } from "~/lib/i18n/translate-messages.server";
import { glossaryFor } from "~/lib/i18n/ui-glossary";

// UI-translation tools (pnpm i18n:translate): input validation, missing/extra keys, merging without overwriting translations, batching, retries and failures.
// No real engine calls: complete is fake. tests/i18n.test.ts checks stored messages/*.json.
describe("placeholders and validateMessage", () => {
  it("lists the {names} of a message once each, sorted", () => {
    expect(placeholders("Page {page} of {max} for {page}")).toEqual(["max", "page"]);
    expect(placeholders("no inputs")).toEqual([]);
  });

  it("accepts a translation with the same inputs, and rejects one that renames, drops or adds one", () => {
    expect(validateMessage("Invitation for {email}", "Invitation pour {email}")).toEqual([]);
    expect(validateMessage("Page {page} of {max}", "Seite {max} von {page}")).toEqual([]);
    expect(validateMessage("Invitation for {email}", "Invitation pour {courriel}")[0]).toContain("placeholders");
    expect(validateMessage("Invitation for {email}", "Invitation")[0]).toContain("placeholders");
    expect(validateMessage("Invitation", "Invitation pour {email}")[0]).toContain("placeholders");
  });

  it("rejects an empty or whitespace-only translation", () => {
    expect(validateMessage("Save", "")).toEqual(["empty"]);
    expect(validateMessage("Save", "   ")).toEqual(["empty"]);
  });

  it("keeps the line structure: a one-line message stays one line, an e-mail keeps its blank lines", () => {
    expect(validateMessage("a\n\n{url}\n\nb", "x\n\n{url}\n\ny")).toEqual([]);
    expect(validateMessage("a\n\n{url}\n\nb", "x {url} y")[0]).toContain("line breaks");
    expect(validateMessage("Save", "Enregistrer\nmaintenant")[0]).toContain("line breaks");
    expect(validateMessage("Save", " Enregistrer")[0]).toContain("whitespace");
  });

  it("requires the terms that are kept as written (the product name, Markdown, API, environment variables…)", () => {
    expect(KEEP_TERMS).toEqual(expect.arrayContaining(["tomola", "Markdown", "API", "OpenAPI", "BETTER_AUTH_URL"]));
    expect(validateMessage("Log in to tomola", "Se connecter à tomola")).toEqual([]);
    expect(validateMessage("Log in to tomola", "Se connecter à Tomola")[0]).toContain('"tomola"');
    expect(validateMessage("Markdown is supported", "マークダウンに対応")[0]).toContain('"Markdown"');
    // Match whole terms, not substrings: API in APIs is checked at a word boundary.
    expect(validateMessage("Use the OpenAPI file", "Utilisez le fichier OpenAPI")).toEqual([]);
    expect(validateMessage("Set BETTER_AUTH_URL", "Définissez BETTER_AUTH_URL")).toEqual([]);
  });

  it("catches letters of another writing system in the middle of a text (a model glitch: Hangul in Thai, Arabic in Vietnamese), in any check", () => {
    expect(validateMessage("Cosine distance", "ระยะห่างโค사인", { locale: "th" })[0]).toContain("another writing system");
    expect(validateMessage("Please revoke one", "Vui lòng thu hồi, Vلحй", { locale: "vi" })[0]).toContain("another writing system");
    expect(validateMessage("Name (for example laptop)", "máyδtính", { locale: "vi" })[0]).toContain("δ");
    // Japanese permits the prolonged sound mark ー and Latin characters.
    expect(validateMessage("Server", "サーバー Server", { locale: "ja" })).toEqual([]);
    expect(validateMessage("Server", "サーバー", { locale: "fr" })[0]).toContain("another writing system");
    expect(validateMessage("Server", "サーバー")).toEqual([]);
  });

  it("with the quality heuristics: a few Latin letters between Thai or Hangul letters are a glitch; a Latin word with a space or a particle is fine", () => {
    expect(validateMessage("Among the topics that received a reply", "ในบรรดาหัวข้อที่ได้รับreการตอบกลับ", { locale: "th", heuristics: true })[0]).toContain("middle of a word");
    expect(validateMessage("Open the Markdown file", "เปิดไฟล์ Markdown", { locale: "th", heuristics: true })).toEqual([]);
    expect(validateMessage("Log in to tomola", "tomola에 로그인", { locale: "ko", heuristics: true })).toEqual([]);
    expect(validateMessage("Reply", "답아bc글", { locale: "ko", heuristics: true })[0]).toContain("middle of a word");
  });

  it("with the quality heuristics: catches an English text returned as it is, and the wrong Chinese script, Hangul or Thai missing", () => {
    const en = "Your votes are counted in this area.";
    expect(validateMessage(en, en, { locale: "fr", heuristics: true })[0]).toContain("unchanged");
    expect(validateMessage(en, en)).toEqual([]);
    expect(validateMessage("Save", "Save", { locale: "fr", heuristics: true })).toEqual([]);
    // A single word or short phrase can legitimately retain its spelling, such as French Notifications.
    expect(validateMessage("Notifications", "Notifications", { locale: "fr", heuristics: true })).toEqual([]);
    expect(validateMessage("Original post", "Original post", { locale: "fr", heuristics: true })).toEqual([]);
    expect(validateMessage(en, "您的投票会在这个区域计算。", { locale: "zh-Hant", heuristics: true })[0]).toContain("Simplified");
    expect(validateMessage(en, "您的投票會在這個區域計算。", { locale: "zh-Hans", heuristics: true })[0]).toContain("Traditional");
    expect(validateMessage(en, "您的投票會在這個區域計算。", { locale: "zh-Hant", heuristics: true })).toEqual([]);
    expect(validateMessage(en, "您的投票会在这个区域计算。", { locale: "zh-Hans", heuristics: true })).toEqual([]);
    // Japanese returned as Korean fails both script-specific and foreign-writing-system checks.
    expect(validateMessage(en, "あなたの票はこの領域で数えられます。", { locale: "ko", heuristics: true }).join(" | ")).toContain("Korean (Hangul) expected");
    expect(validateMessage(en, "Your votes", { locale: "th", heuristics: true })[0]).toContain("Thai");
  });
});

describe("checkMessages, mergeMessages and missingKeys", () => {
  const en = { $schema: "s", a: "Hello {name}", b: "Save", c: "Cancel" };

  it("reports extra keys and invalid inputs, allowing absent target keys unless strict", () => {
    const problems = checkMessages({ en, fr: { $schema: "s", a: "Bonjour {nom}", b: "Enregistrer", z: "x" }, de: { ...en, a: "Hallo {name}", b: "Speichern", c: "Abbrechen" } });
    expect(problems.map((p) => `${p.locale}/${p.key}`).sort()).toEqual(["fr/a", "fr/z"]);
    expect(problems.find((p) => p.key === "c")).toBeUndefined();
    expect(checkMessages({ en, fr: { a: en.a, b: en.b } }, { strict: true }).map(p => p.key)).toEqual(["c"]);
    expect(problems.find((p) => p.key === "z")?.problem).toContain("extra");
    expect(checkMessages({ en, fr: en }, { locales: ["fr", "th"] }).map((p) => p.problem)).toEqual(["the file is missing"]);
  });

  it("rejects absent source/reference keys, while accepting the same absence in engine-translated languages", () => {
    const omitted = { $schema: en.$schema, a: en.a, b: en.b };
    expect(checkMessages({ en, ja: omitted }).map(p => [p.locale, p.key])).toEqual([["ja", "c"]]);
    expect(checkMessages({ en: omitted, ja: en }).map(p => [p.locale, p.key])).toEqual([["ja", "c"]]);
    expect(checkMessages({ en, fr: omitted })).toEqual([]);
    expect(checkMessages({ ja: en }).map(p => p.locale)).toEqual(["en"]);
  });

  it("never overwrites an existing translation; new ones go in the order of the source", () => {
    const existing = { $schema: "s", c: "Annuler (kept)", a: "Bonjour {name}" };
    const merged = mergeMessages(en, existing, { b: "Enregistrer", a: "OVERWRITE", c: "OVERWRITE" });
    expect(merged).toEqual({ $schema: "s", a: "Bonjour {name}", b: "Enregistrer", c: "Annuler (kept)" });
    expect(Object.keys(merged)).toEqual(["$schema", "a", "b", "c"]);
  });

  it("keeps a key that is not in the source at the end instead of deleting it (check reports it)", () => {
    expect(Object.keys(mergeMessages(en, { $schema: "s", old: "x", a: "A {name}" }, { b: "B" }))).toEqual(["$schema", "a", "b", "old"]);
  });

  it("lists the keys of the source that a file does not have yet", () => {
    expect(missingKeys(en, { $schema: "s", b: "x" })).toEqual(["a", "c"]);
    expect(missingKeys(en, en)).toEqual([]);
  });

  it("covers the seven target languages, besides English and Japanese", () => {
    expect(TARGET_LOCALES).toEqual(["fr", "de", "zh-Hant", "zh-Hans", "ko", "th", "vi"]);
    expect(ALL_LOCALES).toHaveLength(9);
  });
});

describe("translateMessages", () => {
  const source = { a: "Hello {name}", b: "Save", c: "Cancel", d: "Open the Markdown file" };
  const reference = { a: "こんにちは {name}", b: "保存", c: "キャンセル", d: "Markdown ファイルを開く" };
  const answers: Record<string, string> = { a: "Bonjour {name}", b: "Enregistrer", c: "Annuler", d: "Ouvrir le fichier Markdown" };

  function fakeComplete(respond: (items: Record<string, { en: string; ja?: string; fix?: string }>, call: number) => unknown) {
    const calls: Array<{ system: string; items: Record<string, { en: string; ja?: string; fix?: string }> }> = [];
    const complete: Complete = async ({ system, user }) => {
      const items = JSON.parse(user) as Record<string, { en: string; ja?: string; fix?: string }>;
      calls.push({ system, items });
      const out = respond(items, calls.length);
      return { text: typeof out === "string" ? out : JSON.stringify(out), inputTokens: 100, outputTokens: 50 };
    };
    return { complete, calls };
  }
  const base = { locale: "fr" as const, source, reference, glossary: glossaryFor("fr") };

  it("sends the English text and the Japanese reference, and returns the accepted translations", async () => {
    const { complete, calls } = fakeComplete((items) => Object.fromEntries(Object.keys(items).map((k) => [k, answers[k]])));
    const accepted: Array<import("~/lib/i18n/messages").Messages> = [];
    const res = await translateMessages({ ...base, keys: ["a", "b"], complete, onAccepted: (m) => void accepted.push(m) });
    expect(res.translated).toEqual({ a: "Bonjour {name}", b: "Enregistrer" });
    expect(res.failed).toEqual({});
    expect(calls).toHaveLength(1);
    expect(calls[0].items).toEqual({ a: { en: "Hello {name}", ja: "こんにちは {name}" }, b: { en: "Save", ja: "保存" } });
    expect(accepted).toEqual([{ a: "Bonjour {name}", b: "Enregistrer" }]);
    expect(res).toMatchObject({ calls: 1, inputTokens: 100, outputTokens: 50, retriedKeys: 0, stopped: null });
  });

  it("splits the keys into batches", async () => {
    const { complete, calls } = fakeComplete((items) => Object.fromEntries(Object.keys(items).map((k) => [k, answers[k]])));
    const res = await translateMessages({ ...base, keys: ["a", "b", "c", "d"], batchSize: 3, complete });
    expect(calls.map((c) => Object.keys(c.items))).toEqual([["a", "b", "c"], ["d"]]);
    expect(Object.keys(res.translated)).toHaveLength(4);
  });

  it("asks again, with the problem, for a translation that fails the check, and then accepts the fixed one", async () => {
    const { complete, calls } = fakeComplete((items, call) =>
      Object.fromEntries(Object.keys(items).map((k) => [k, call === 1 && k === "a" ? "Bonjour {nom}" : answers[k]])),
    );
    const res = await translateMessages({ ...base, keys: ["a", "b"], complete });
    expect(res.translated).toEqual({ a: "Bonjour {name}", b: "Enregistrer" });
    expect(calls).toHaveLength(2);
    expect(Object.keys(calls[1].items)).toEqual(["a"]);
    expect(calls[1].items.a.fix).toContain("placeholders");
    expect(res.retriedKeys).toBe(1);
  });

  it("does not add a translation that never passes: it is reported as failed, after the attempts", async () => {
    const { complete, calls } = fakeComplete((items) => Object.fromEntries(Object.keys(items).map((k) => [k, k === "d" ? "Ouvrir le fichier markdown" : answers[k]])));
    const saved: string[] = [];
    const res = await translateMessages({ ...base, keys: ["b", "d"], complete, maxAttempts: 3, onAccepted: (m) => void saved.push(...Object.keys(m)) });
    expect(res.translated).toEqual({ b: "Enregistrer" });
    expect(Object.keys(res.failed)).toEqual(["d"]);
    expect(res.failed.d[0]).toContain('"Markdown"');
    expect(saved).toEqual(["b"]);
    expect(calls).toHaveLength(3);
  });

  it("retries a response that is not a JSON object, and a key the answer leaves out", async () => {
    const { complete } = fakeComplete((items, call) => (call === 1 ? "I cannot do that" : Object.fromEntries(Object.keys(items).filter((k) => !(call === 2 && k === "c")).map((k) => [k, answers[k]]))));
    const res = await translateMessages({ ...base, keys: ["b", "c"], complete });
    expect(res.translated).toEqual({ b: "Enregistrer", c: "Annuler" });
    expect(res.calls).toBe(3);
  });

  it("stops when shouldStop says so (the cost limit), reporting what was not translated", async () => {
    let n = 0;
    const { complete } = fakeComplete((items) => Object.fromEntries(Object.keys(items).map((k) => [k, answers[k]])));
    const res = await translateMessages({ ...base, keys: ["a", "b", "c", "d"], batchSize: 2, complete, shouldStop: () => (n++ >= 1 ? "the cost passed the limit" : null) });
    expect(res.stopped).toBe("the cost passed the limit");
    expect(Object.keys(res.translated)).toEqual(["a", "b"]);
    expect(Object.keys(res.failed)).toEqual(["c", "d"]);
  });

  it("passes a fatal error (a used-up daily quota) on at once, without trying the rest", async () => {
    let calls = 0;
    const complete: Complete = async () => {
      calls++;
      throw new FatalTranslationError("the daily quota is used up");
    };
    await expect(translateMessages({ ...base, keys: ["a", "b", "c", "d"], batchSize: 1, complete })).rejects.toThrow("daily quota");
    expect(calls).toBe(1);
  });

  it("goes on after an ordinary failure of a call (the keys are tried again)", async () => {
    const { complete } = fakeComplete((items, call) => {
      if (call === 1) throw new Error("socket hang up");
      return Object.fromEntries(Object.keys(items).map((k) => [k, answers[k]]));
    });
    const res = await translateMessages({ ...base, keys: ["b"], complete });
    expect(res.translated).toEqual({ b: "Enregistrer" });
  });

  it("reads a response that the model wrapped in a code fence", () => {
    expect(parseResponse('```json\n{"a":"x"}\n```')).toEqual({ a: "x" });
    expect(parseResponse("[1,2]")).toBeNull();
    expect(parseResponse("nope")).toBeNull();
  });
});

describe("the prompt", () => {
  it("names the language, the style for it, the terms to keep, and the glossary of that language", () => {
    const p = systemPrompt("zh-Hant", glossaryFor("zh-Hant"));
    expect(p).toContain("into Traditional Chinese");
    expect(p).toContain("vocabulary, usage and orthography of Taiwan");
    expect(p).toContain("tomola, Markdown, API, OpenAPI");
    expect(p).toContain('"topic" -> "話題"');
    expect(p).toContain('"passkey" -> "通行密鑰"');
    expect(p).toContain("{placeholder}");
    expect(systemPrompt("de", glossaryFor("de"))).toContain("Sie");
  });
});

describe("stale translations (the fingerprints of the English source)", () => {
  const en = { $schema: "s", a: "Hello {name}", b: "Save", c: "Cancel" };
  const fr = { $schema: "s", a: "Bonjour {name}", b: "Enregistrer", c: "Annuler" };

  it("fingerprints the English text: the first 16 hex digits of its sha1", () => {
    expect(fingerprint("Save")).toMatch(new RegExp(`^[0-9a-f]{${HASH_LENGTH}}$`));
    expect(fingerprint("Save")).toBe(fingerprint("Save"));
    expect(fingerprint("Save")).not.toBe(fingerprint("Save "));
  });

  it("knows no key is stale right after the hashes are recorded, and flags exactly the keys whose English changed", () => {
    const hashes = initialHashes(en, { fr });
    expect(staleKeys(en, fr, hashes.fr)).toEqual([]);
    expect(checkStale(en, { en, fr }, hashes, ["fr"])).toEqual([]);
    const changed = { ...en, b: "Save changes" };
    expect(staleKeys(changed, fr, hashes.fr)).toEqual(["b"]);
    const problems = checkStale(changed, { en: changed, fr }, hashes, ["fr"]);
    expect(problems).toEqual([{ locale: "fr", key: "b", problem: expect.stringContaining("stale: the English source changed") }]);
  });

  it("flags a translation that has no recorded fingerprint, a key that is new, and ignores a locale that has no file", () => {
    expect(staleKeys(en, fr, {})).toEqual(["a", "b", "c"]);
    expect(checkStale(en, { en, fr }, {}, ["fr", "th"]).map((p) => `${p.locale}/${p.key}`)).toEqual(["fr/a", "fr/b", "fr/c"]);
    expect(checkStale(en, { en, fr }, {}, ["fr"])[0].problem).toContain("no source fingerprint");
    // A new untranslated key is "足りない" (missing), not "古い" (stale); checkMessages reports it.
    expect(staleKeys({ ...en, d: "New" }, fr, initialHashes(en, { fr }).fr)).toEqual([]);
  });

  it("stamps only the keys it is given, per language, and leaves the other fingerprints as they are", () => {
    const changed = { ...en, a: "Hi {name}", b: "Save changes" };
    const hashes = initialHashes(en, { fr, de: fr });
    const stamped = stamp(hashes, "fr", changed, ["a"]);
    expect(staleKeys(changed, fr, stamped.fr)).toEqual(["b"]);
    // Leave the other language unchanged and stale.
    expect(staleKeys(changed, fr, stamped.de).sort()).toEqual(["a", "b"]);
    // Do not record keys absent from the source.
    expect(Object.keys(stamp({}, "fr", en, ["zzz", "a"]).fr)).toEqual(["a"]);
    // Do not mutate the original records.
    expect(staleKeys(changed, fr, hashes.fr).sort()).toEqual(["a", "b"]);
  });

  it("replaces only the stale keys of a file, in the order of the source", () => {
    const merged = replaceMessages(en, fr, { b: "Sauvegarder", z: "not in the source" });
    expect(merged).toEqual({ $schema: "s", a: "Bonjour {name}", b: "Sauvegarder", c: "Annuler" });
    expect(Object.keys(merged)).toEqual(["$schema", "a", "b", "c"]);
  });

  it("writes the file in the order of the source with a comment, and reads it back", () => {
    const hashes = initialHashes(en, { fr });
    const text = serializeHashes(hashes, en, ["fr", "th"]);
    expect(JSON.parse(text).$comment).toContain("sha1");
    expect(Object.keys(JSON.parse(text).fr)).toEqual(["a", "b", "c"]);
    expect(JSON.parse(text).th).toEqual({});
    expect(parseHashes(text).fr).toEqual(hashes.fr);
    expect(parseHashes(text).$comment).toBeUndefined();
  });
});

describe("translateFiles: the files and the fingerprints after a run with a fake engine", () => {
  const SOURCE = { $schema: "s", a: "Hello {name}", b: "Save", c: "Cancel" };
  const REFERENCE = { $schema: "s", a: "こんにちは {name}", b: "保存", c: "キャンセル" };
  const FR = { $schema: "s", a: "Bonjour {name}", b: "Enregistrer", c: "Annuler" };
  const GOOD: Record<string, string> = { a: "Salut {name}", b: "Sauver", c: "Quitter", d: "Nouveau" };

  function setup(opts: { source?: Record<string, string>; fr?: Record<string, string> } = {}) {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "i18n-run-"));
    const write = (name: string, value: unknown) => fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
    write("en.json", SOURCE);
    write("ja.json", REFERENCE);
    write("fr.json", FR);
    // Record current translations as matching the current source.
    write(".source-hashes.json", JSON.parse(serializeHashes(initialHashes(SOURCE, { fr: FR }), SOURCE)));
    // Edit the source.
    if (opts.source) write("en.json", opts.source);
    if (opts.fr) write("fr.json", opts.fr);
    const read = (name: string) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as Record<string, string>;
    return { dir, read };
  }
  const answering = (answers: (key: string) => string | undefined) => {
    const asked: string[][] = [];
    const complete: Complete = async ({ user }) => {
      const items = JSON.parse(user) as Record<string, unknown>;
      asked.push(Object.keys(items));
      return { text: JSON.stringify(Object.fromEntries(Object.keys(items).flatMap((k) => (answers(k) === undefined ? [] : [[k, answers(k)]])))), inputTokens: 1, outputTokens: 1 };
    };
    return { complete, asked };
  };
  const cleanup: string[] = [];
  afterEach(() => {
    for (const d of cleanup.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("--stale re-translates only the stale keys, leaves every other translation and file as it is, and records the new fingerprints", async () => {
    const t = setup({ source: { ...SOURCE, b: "Save changes" } });
    cleanup.push(t.dir);
    const { complete, asked } = answering((k) => GOOD[k]);
    const summary = await translateFiles({ dir: t.dir, locales: ["fr", "de"], mode: "stale", complete });
    // de has no translation file and thus no stale keys, so translate nothing. For fr, only b.
    expect(asked).toEqual([["b"]]);
    expect(summary.find((s) => s.locale === "fr")).toMatchObject({ keys: 1, added: 1 });
    expect(t.read("fr.json")).toEqual({ $schema: "s", a: "Bonjour {name}", b: "Sauver", c: "Annuler" });
    expect(fs.existsSync(path.join(t.dir, "de.json"))).toBe(false);
    const hashes = parseHashes(fs.readFileSync(path.join(t.dir, ".source-hashes.json"), "utf8"));
    expect(staleKeys({ ...SOURCE, b: "Save changes" }, t.read("fr.json"), hashes.fr)).toEqual([]);
  });

  it("does not touch a stale translation or its fingerprint when the new translation fails the checks; the key stays stale", async () => {
    const t = setup({ source: { ...SOURCE, a: "Hello {name}, welcome" } });
    cleanup.push(t.dir);
    const hashesBefore = fs.readFileSync(path.join(t.dir, ".source-hashes.json"), "utf8");
    // Reject translations missing {name}, even after three retries.
    const { complete, asked } = answering(() => "Bonjour et bienvenue");
    const summary = await translateFiles({ dir: t.dir, locales: ["fr"], mode: "stale", complete });
    expect(asked).toHaveLength(3);
    expect(Object.keys(summary[0].failed)).toEqual(["a"]);
    expect(t.read("fr.json")).toEqual(FR);
    expect(fs.readFileSync(path.join(t.dir, ".source-hashes.json"), "utf8")).toBe(hashesBefore);
    expect(staleKeys({ ...SOURCE, a: "Hello {name}, welcome" }, FR, parseHashes(hashesBefore).fr)).toEqual(["a"]);
  });

  it("records the fingerprint of a key only after its batch was written: a call that throws midway keeps the earlier batches", async () => {
    const t = setup({ source: { ...SOURCE, a: "Hello {name}!", b: "Save now", c: "Cancel it" } });
    cleanup.push(t.dir);
    let calls = 0;
    const complete: Complete = async ({ user }) => {
      const items = Object.keys(JSON.parse(user) as Record<string, unknown>);
      if (++calls === 2) throw new FatalTranslationError("daily quota");
      return { text: JSON.stringify(Object.fromEntries(items.map((k) => [k, k === "a" ? "Salut {name} !" : `fr-${k}`]))), inputTokens: 1, outputTokens: 1 };
    };
    await expect(translateFiles({ dir: t.dir, locales: ["fr"], mode: "stale", complete, batchSize: 1 })).rejects.toThrow("daily quota");
    // The first batch a retains its translation and fingerprint; remaining keys stay stale.
    expect(t.read("fr.json").a).toBe("Salut {name} !");
    expect(t.read("fr.json").b).toBe("Enregistrer");
    const hashes = parseHashes(fs.readFileSync(path.join(t.dir, ".source-hashes.json"), "utf8"));
    expect(staleKeys({ ...SOURCE, a: "Hello {name}!", b: "Save now", c: "Cancel it" }, t.read("fr.json"), hashes.fr)).toEqual(["b", "c"]);
  });

  it("a normal run adds only the missing keys, never overwrites an existing translation, even a stale one, and records the new keys", async () => {
    const t = setup({ source: { ...SOURCE, b: "Save changes", d: "New" }, fr: FR });
    cleanup.push(t.dir);
    fs.writeFileSync(path.join(t.dir, "ja.json"), JSON.stringify({ ...REFERENCE, d: "新しい" }));
    const { complete, asked } = answering((k) => GOOD[k]);
    await translateFiles({ dir: t.dir, locales: ["fr"], mode: "missing", complete });
    expect(asked).toEqual([["d"]]);
    expect(t.read("fr.json")).toEqual({ ...FR, d: "Nouveau" });
    const hashes = parseHashes(fs.readFileSync(path.join(t.dir, ".source-hashes.json"), "utf8"));
    // b stays stale because ordinary runs do not repair it; d is recorded.
    expect(staleKeys({ ...SOURCE, b: "Save changes", d: "New" }, t.read("fr.json"), hashes.fr)).toEqual(["b"]);
  });

  it("refuses to run without the fingerprints file", async () => {
    const t = setup();
    cleanup.push(t.dir);
    fs.rmSync(path.join(t.dir, ".source-hashes.json"));
    await expect(translateFiles({ dir: t.dir, locales: ["fr"], mode: "stale", complete: answering(() => "x").complete })).rejects.toThrow(".source-hashes.json is missing");
  });
});

describe("dropStaleFiles: remove obsolete translations without translating", () => {
  const source = { $schema: "s", a: "Hello {name}", b: "Save", c: "Cancel" };
  const translated = { $schema: "s", a: "Bonjour {name}", b: "Enregistrer", c: source.c };
  const cleanup: string[] = [];
  afterEach(() => {
    for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });
  function setup() {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "i18n-drop-"));
    cleanup.push(dir);
    const write = (name: string, value: unknown) => fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
    const read = (name: string) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
    write("en.json", { ...source, b: `${source.b} updated`, new_key: source.a });
    write("ja.json", source);
    for (const locale of ["fr", "de"]) write(`${locale}.json`, { ...translated, extra: source.c });
    const hashes = initialHashes(source, { fr: translated, de: translated });
    for (const locale of ["fr", "de"]) Object.assign(hashes[locale], { extra: fingerprint(source.c), orphan: fingerprint(source.a) });
    write(".source-hashes.json", hashes);
    return { dir, read, write, hashes };
  }

  it("removes stale and extra keys and orphan records only in selected languages, keeping current and English-identical translations", () => {
    const t = setup();
    const other = t.read("de.json");
    const sourceBefore = t.read("en.json");
    const referenceBefore = t.read("ja.json");
    const summary = dropStaleFiles({ dir: t.dir, locales: ["fr"] });
    const kept = { $schema: source.$schema, a: translated.a, c: translated.c };
    expect(t.read("fr.json")).toEqual(kept);
    expect(summary).toEqual([{ locale: "fr", keys: ["b", "extra"].length, hashes: ["b", "extra", "orphan"].length }]);
    const hashes = parseHashes(fs.readFileSync(path.join(t.dir, ".source-hashes.json"), "utf8"));
    expect(hashes.fr).toEqual(initialHashes(source, { fr: kept }).fr);
    expect(hashes.de).toEqual(t.hashes.de);
    expect(t.read("de.json")).toEqual(other);
    expect(t.read("en.json")).toEqual(sourceBefore);
    expect(t.read("ja.json")).toEqual(referenceBefore);
    expect(Object.keys(t.read("fr.json"))).toEqual(Object.keys(kept));
    const before = fs.readFileSync(path.join(t.dir, ".source-hashes.json"), "utf8");
    expect(dropStaleFiles({ dir: t.dir, locales: ["fr"] })).toEqual([{ locale: "fr", keys: [].length, hashes: [].length }]);
    expect(fs.readFileSync(path.join(t.dir, ".source-hashes.json"), "utf8")).toBe(before);
  });

  it("removes orphan records even when the entire translation file is absent, without creating that file", () => {
    const t = setup();
    fs.rmSync(path.join(t.dir, "fr.json"));
    const summary = dropStaleFiles({ dir: t.dir, locales: ["fr"] });
    expect(summary).toEqual([{ locale: "fr", keys: [].length, hashes: Object.keys(t.hashes.fr).length }]);
    expect(fs.existsSync(path.join(t.dir, "fr.json"))).toBe(false);
    expect(parseHashes(fs.readFileSync(path.join(t.dir, ".source-hashes.json"), "utf8")).fr).toEqual({});
  });

  it("refuses to run without fingerprints and reports orphan records during validation", () => {
    const t = setup();
    expect(checkStale(source, { fr: translated }, t.hashes, ["fr"]).map(p => p.key)).toEqual(["extra", "orphan"]);
    fs.rmSync(path.join(t.dir, ".source-hashes.json"));
    expect(() => dropStaleFiles({ dir: t.dir, locales: ["fr"] })).toThrow(/source-hashes/);
  });
});

describe("pnpm i18n:translate --check, --stamp and --init-hashes", () => {
  // Put message files in a temporary directory, optionally records with withHashes, then run the script.
  async function run(files: Record<string, unknown>, args: string[] = ["--check"], opts: { withHashes?: boolean } = {}) {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "i18n-"));
    try {
      for (const [locale, messages] of Object.entries(files)) fs.writeFileSync(path.join(dir, `${locale}.json`), JSON.stringify(messages));
      const exec = async (a: string[]) => (await invokeI18n([...a], { ...process.env, I18N_MESSAGES_DIR: dir }));
      if (opts.withHashes ?? true) expect((await exec(["--init-hashes"])).status).toBe(0);
      return await (await exec(args));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  const en = { $schema: "s", a: "Hello {name}", b: "Save" };
  const complete = Object.fromEntries(ALL_LOCALES.filter((l) => l !== "en").map((l) => [l, { $schema: "s", a: `[${l}] {name}`, b: `[${l}]` }]));

  // Starting tsx may exceed the default five seconds under parallel CPU load.
  it("exits 0 when every language has every key with the same inputs, and none is stale", { timeout: 60_000 }, async () => {
    const res = (await run({ en, ...complete }));
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("no problems");
  });

  it("exits 1, naming the language, the key and the problem, when a language drifts", { timeout: 60_000 }, async () => {
    const res = (await run({ en, ...complete, th: { $schema: "s", a: "[th] {nom}", extra: "x" } }));
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("th/a: placeholders");
    expect(res.stderr).not.toContain("th/b: missing");
    expect(res.stderr).toContain("th/extra: extra");
  });

  it("exits 1 and names the stale keys when the English changed after the hashes were recorded", { timeout: 90_000 }, async () => {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "i18n-"));
    try {
      for (const [locale, messages] of Object.entries({ en, ...complete })) fs.writeFileSync(path.join(dir, `${locale}.json`), JSON.stringify(messages));
      const env = { ...process.env, I18N_MESSAGES_DIR: dir };
      const exec = async (a: string[]) => (await invokeI18n([...a], env));
      expect((await exec(["--init-hashes"])).status).toBe(0);
      expect((await exec(["--check"])).status).toBe(0);
      expect((await exec(["--check", "--require-verified", "--lang", "ja"])).status).toBe(0);
      // --init-hashes refuses existing records rather than masking stale translations.
      const again = (await exec(["--init-hashes"]));
      expect(again.status).toBe(1);
      expect(again.stderr).toContain("already exists");
      // Edit source b without changing keys or inputs; translations pass ordinary checks but are stale.
      fs.writeFileSync(path.join(dir, "en.json"), JSON.stringify({ ...en, b: "Save changes" }));
      const stale = (await exec(["--check"]));
      expect(stale.status).toBe(1);
      for (const locale of TARGET_LOCALES) expect(stale.stderr).toContain(`${locale}/b: stale: the English source changed`);
      expect(stale.stderr).not.toContain("/a: stale");
      // Stamp human-corrected translations; only that language passes.
      expect((await exec(["--stamp", "b", "--lang", "fr"])).status).toBe(0);
      const partial = (await exec(["--check"]));
      expect(partial.stderr).not.toContain("fr/b");
      expect(partial.stderr).toContain("de/b: stale");
      expect((await exec(["--stamp", "b"])).status).toBe(0);
      expect((await exec(["--check"])).stderr).toContain("ja/b: stale");
      expect((await exec(["--stamp", "b", "--lang", "ja"])).status).toBe(0);
      expect((await exec(["--check"])).status).toBe(0);
      // --stamp rejects missing keys and keys absent from the source.
      expect((await exec(["--stamp", "nope"])).status).toBe(1);
      expect((await exec(["--stamp"])).status).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits 1 when the hashes file is missing", { timeout: 60_000 }, async () => {
    const res = (await run({ en, ...complete }, ["--check"], { withHashes: false }));
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(".source-hashes.json is missing");
  });

  it("refuses to translate without an API key, and --stale with nothing stale does nothing", { timeout: 60_000 }, async () => {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "i18n-"));
    try {
      for (const [locale, messages] of Object.entries({ en, ...complete })) fs.writeFileSync(path.join(dir, `${locale}.json`), JSON.stringify(messages));
      const env = { ...process.env, I18N_MESSAGES_DIR: dir, GEMINI_API_KEY: "" };
      const exec = async (a: string[]) => (await invokeI18n([...a], env));
      expect((await exec(["--init-hashes"])).status).toBe(0);
      const nothing = (await exec(["--stale"]));
      expect(nothing.status).toBe(0);
      expect(nothing.stdout).toContain("no translation is stale");
      // --stale counts only stale keys; --dry-run makes no calls. Other keys and languages remain unchanged.
      fs.writeFileSync(path.join(dir, "en.json"), JSON.stringify({ ...en, b: "Save changes" }));
      const dry = (await exec(["--stale", "--dry-run", "--lang", "fr,de"]));
      expect(dry.status).toBe(0);
      expect(dry.stdout).toContain("fr: 1 stale key(s) to translate");
      expect(dry.stdout).toContain("de: 1 stale key(s) to translate");
      expect(dry.stdout).not.toContain("th:");
      const noKey = (await exec(["--stale"]));
      expect(noKey.status).toBe(1);
      expect(noKey.stderr).toContain("GEMINI_API_KEY is not set");
      // A failed run changes neither translations nor fingerprints.
      expect(JSON.parse(fs.readFileSync(path.join(dir, "fr.json"), "utf8")).b).toBe("[fr]");
      expect((await exec(["--check"])).status).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("--drop-stale uses no API, respects --lang, and leaves absent translations for ordinary translation and strict review", { timeout: 120_000 }, async () => {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "i18n-drop-cli-"));
    try {
      const write = (locale: string, value: unknown) => fs.writeFileSync(path.join(dir, `${locale}.json`), JSON.stringify(value));
      const read = (locale: string) => JSON.parse(fs.readFileSync(path.join(dir, `${locale}.json`), "utf8"));
      for (const [locale, messages] of Object.entries({ en, ...complete })) write(locale, messages);
      const exec = async (a: string[]) => (await invokeI18n([...a], { ...process.env, I18N_MESSAGES_DIR: dir, GEMINI_API_KEY: "", ANTHROPIC_API_KEY: "", TRANSLATION_PRIMARY: "fake" }));
      expect((await exec(["--init-hashes"])).status).toBe(0);
      const updated = { ...en, b: `${en.b} updated`, c: en.a };
      write("en", updated);
      write("ja", { ...complete.ja, c: complete.ja.a });
      const before = (await exec(["--check"]));
      expect(before.status).toBe(1);
      expect(before.stderr).toContain("fr/b: stale");
      expect(before.stderr).not.toContain("fr/c: missing");
      expect((await exec(["--drop-stale", "--lang", "fr"])).status).toBe(0);
      expect(read("fr")).toEqual({ $schema: en.$schema, a: complete.fr.a });
      expect(read("de")).toEqual(complete.de);
      expect((await exec(["--check"])).status).toBe(1); // Other languages still have stale translations.
      expect((await exec(["--drop-stale"])).status).toBe(0);
      expect(read("ja")).toEqual({ ...complete.ja, c: complete.ja.a });
      expect((await exec(["--stamp", "b", "c", "--lang", "ja"])).status).toBe(0);
      expect((await exec(["--check"])).status).toBe(0);
      for (const locale of TARGET_LOCALES) {
        const strict = (await exec(["--check", "--strict", "--lang", locale]));
        expect(strict.status, locale).toBe(1);
        for (const key of ["b", "c"]) expect(strict.stderr).toContain(`${locale}/${key}: missing`);
      }
      // Missing keys are handled by the default translation mode; --stale has nothing left to replace.
      expect(keysToTranslateForTest(dir, "fr", "missing")).toEqual(["b", "c"]);
      expect((await exec(["--stale", "--dry-run", "--lang", "fr"])).stdout).toContain("no translation is stale");
      write("fr", { ...complete.fr, b: complete.fr.b, c: complete.fr.a });
      expect((await exec(["--stamp", "b", "c", "--lang", "fr"])).status).toBe(0);
      expect((await exec(["--check", "--strict", "--lang", "fr"])).status).toBe(0);
      expect(read("en")).toEqual(updated);
      expect(read("ja")).toEqual({ ...complete.ja, c: complete.ja.a });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

// --emit-review-counts: the per-language counts of missing and unverified UI keys that the build embeds and the production startup check reads.
describe("pnpm i18n:translate --emit-review-counts", () => {
  const en = { $schema: "s", a: "Hello {name}", b: "Save", c: "Cancel" };
  const complete = Object.fromEntries(ALL_LOCALES.filter((l) => l !== "en").map((l) => [l, { $schema: "s", a: `[${l}] {name}`, b: `[${l}]`, c: `[${l}] c` }]));

  it("writes the counts of all nine languages, equal to the problems of --check --require-verified, with the date of the last check and no name", { timeout: 120_000 }, async () => {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "i18n-"));
    const out = path.join(dir, "review-counts.generated.json");
    try {
      for (const [locale, messages] of Object.entries({ en, ...complete })) fs.writeFileSync(path.join(dir, `${locale}.json`), JSON.stringify(messages));
      const env = { ...process.env, I18N_MESSAGES_DIR: dir, I18N_REVIEW_COUNTS_FILE: out, GEMINI_API_KEY: "" };
      const exec = async (a: string[]) => (await invokeI18n([...a], env));
      expect((await exec(["--init-hashes"])).status).toBe(0);
      // Omit untranslated "c" in fr and have a native speaker check de completely.
      fs.writeFileSync(path.join(dir, "fr.json"), JSON.stringify({ ...complete.fr, c: undefined }));
      const hashes = JSON.parse(fs.readFileSync(path.join(dir, ".source-hashes.json"), "utf8")) as Record<string, Record<string, string>>;
      delete hashes.fr.c;
      fs.writeFileSync(path.join(dir, ".source-hashes.json"), JSON.stringify(hashes));
      expect((await exec(["--verify", "--lang", "de", "--by", "Dana Reviewer", "--all"])).status).toBe(0);

      const res = (await exec(["--emit-review-counts"]));
      expect(res.status).toBe(0);
      const counts = JSON.parse(fs.readFileSync(out, "utf8")) as Record<string, { unverified: number; missing: number; stale: number; verifiedAt?: string | null }>;
      expect(Object.keys(counts)).toEqual(["ja", "en", "fr", "de", "zh-Hant", "zh-Hans", "ko", "th", "vi"]);
      expect(counts.ja).toEqual({ unverified: 0, unverifiedPublic: 0, missing: 0, stale: 0 });
      expect(counts.en).toEqual({ unverified: 0, unverifiedPublic: 0, missing: 0, stale: 0 });
      expect(counts.fr).toMatchObject({ missing: ["c"].length, unverified: 2, unverifiedPublic: 2, verifiedAt: null });
      expect(counts.de).toMatchObject({ unverified: 0 });
      expect(counts.de.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(counts.ko).toMatchObject({ unverified: 3 });
      // The name of the person who checked is never written.
      expect(fs.readFileSync(out, "utf8")).not.toContain("Dana");

      // The same counting as --check --require-verified: one problem per missing and per unverified key.
      const check = (await exec(["--check", "--require-verified"]));
      expect(check.status).toBe(1);
      for (const locale of TARGET_LOCALES) {
        const lines = check.stderr.split("\n").filter((l) => l.startsWith(`${locale}/`));
        expect(lines.length, locale).toBe(counts[locale].missing + counts[locale].unverified);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails without writing when the hashes file is missing", { timeout: 60_000 }, async () => {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "i18n-"));
    const out = path.join(dir, "review-counts.generated.json");
    try {
      for (const [locale, messages] of Object.entries({ en, ...complete })) fs.writeFileSync(path.join(dir, `${locale}.json`), JSON.stringify(messages));
      const res = (await invokeI18n(["--emit-review-counts"], { ...process.env, I18N_MESSAGES_DIR: dir, I18N_REVIEW_COUNTS_FILE: out }));
      expect(res.status).toBe(1);
      expect(res.stderr).toContain(".source-hashes.json is missing");
      expect(fs.existsSync(out)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("embeds missing keys and obsolete fingerprints for the runtime gate without calling an API", { timeout: 60_000 }, async () => {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "i18n-"));
    const out = path.join(dir, "review-counts.generated.json");
    try {
      const files = { en, ...complete };
      for (const [locale, messages] of Object.entries(files)) fs.writeFileSync(path.join(dir, `${locale}.json`), JSON.stringify(messages));
      fs.writeFileSync(path.join(dir, ".source-hashes.json"), serializeHashes(initialHashes(en, files), en));
      fs.writeFileSync(path.join(dir, "en.json"), JSON.stringify({ ...en, a: "Welcome {name}" }));
      fs.writeFileSync(path.join(dir, "ja.json"), JSON.stringify({ ...complete.ja, c: undefined }));
      fs.writeFileSync(path.join(dir, "fr.json"), JSON.stringify({ ...complete.fr, c: undefined }));
      fs.rmSync(path.join(dir, "ko.json"));
      const result = (await invokeI18n(["--emit-review-counts"], { ...process.env, I18N_MESSAGES_DIR: dir, I18N_REVIEW_COUNTS_FILE: out, GEMINI_API_KEY: "", ANTHROPIC_API_KEY: "" }));
      expect(result.status, result.stderr).toBe(0);
      const counts = JSON.parse(fs.readFileSync(out, "utf8"));
      expect(counts.en).toEqual({ unverified: 0, unverifiedPublic: 0, missing: 0, stale: 0 });
      expect(counts.ja).toEqual({ unverified: 0, unverifiedPublic: 0, missing: 1, stale: 2 });
      expect(counts.fr).toMatchObject({ missing: ["c"].length, stale: ["a", "c"].length });
      expect(counts.de).toMatchObject({ missing: 0, stale: 1 });
      expect(counts.ko).toMatchObject({ missing: 3 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

it("the translation CLI parses options and reports success and failure through its exit status", { timeout: 90_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "i18n-cli-"));
  try {
    for (const locale of ALL_LOCALES) fs.writeFileSync(path.join(dir, `${locale}.json`), JSON.stringify({ a: locale === "en" ? "Hello" : "Translated" }));
    const env = { PATH: process.env.PATH, NODE_ENV: "test", I18N_MESSAGES_DIR: dir, GEMINI_API_KEY: "", ANTHROPIC_API_KEY: "" };
    const run = async (args: string[]) => spawnSync(path.resolve("node_modules/.bin/tsx"), ["scripts/i18n-translate.ts", ...args], { env, encoding: "utf8", timeout: 30_000 });
    const bad = (await run(["--unknown"])); expect(bad.status).toBe(1); expect(bad.stderr).toContain("unknown argument");
    const ok = (await run(["--init-hashes"])); expect(ok.status, ok.stderr).toBe(0);
    expect(fs.existsSync(path.join(dir, ".source-hashes.json"))).toBe(true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
