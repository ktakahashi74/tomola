import { invokeI18n, type CliResult } from "./helpers/cli";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ALL_LOCALES, TARGET_LOCALES } from "~/lib/i18n/messages";
import { initialHashes, fingerprint } from "~/lib/i18n/source-hashes";
import { addCheck, markVerified, parseChecks, parseVerified, serializeVerified, unverifiedCounts, unverifiedKeys } from "~/lib/i18n/verification";
import { translateMessages } from "~/lib/i18n/translate-messages.server";
import { glossaryFor } from "~/lib/i18n/ui-glossary";
import { createJsonCompleter, DEFAULT_I18N_MODELS } from "~/lib/llm/completion.server";
import type { ClaudeClient, ClaudeMessage } from "~/lib/llm/engines/claude.server";
import type { GeminiClient, GeminiResponse } from "~/lib/llm/engines/gemini.server";

// pnpm i18n:translate selects engines (--engine) and models (--model) through the project LLM layer and records native-speaker verification (unverified). Never call real APIs
// with these tests: fake clients and engines only, no keys required.

const en = { $schema: "s", a: "Hello {name}", b: "Save", c: "Cancel the changes you made" };

function geminiStub(respond: (user: string) => string) {
  const generateContent = vi.fn(async (params: unknown) => {
    const p = params as { contents: string };
    return { text: respond(p.contents), candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 } } as unknown as GeminiResponse;
  });
  return { client: { models: { generateContent } } satisfies GeminiClient, generateContent };
}

function claudeStub(respond: (user: string) => string) {
  const create = vi.fn(async (body: unknown, _options?: unknown) => {
    const b = body as { messages: Array<{ content: string }> };
    return { content: [{ type: "text", text: respond(b.messages[0].content), citations: null }], stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 50 } } as unknown as ClaudeMessage;
  });
  return { client: { messages: { create } } satisfies ClaudeClient, create };
}

// Build {id: "[fr] 原文"} from the JSON user message.
const frenchOf = (user: string) => JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(user) as Record<string, { en: string }>).map(([k, v]) => [k, `[fr] ${v.en}`])));

describe("createJsonCompleter: the engines of pnpm i18n:translate", () => {
  it("uses the default Gemini interface-message model with JSON output and low thinking", async () => {
    const stub = geminiStub(frenchOf);
    const completer = createJsonCompleter("gemini", DEFAULT_I18N_MODELS.gemini, {}, { geminiClient: stub.client });
    expect(completer).toMatchObject({ engine: "gemini", model: "gemini-3.8-flash" });
    const out = await completer.complete({ system: "SYS", user: JSON.stringify({ a: { en: "Hello" } }), maxOutputTokens: 1234 });
    expect(JSON.parse(out.text)).toEqual({ a: "[fr] Hello" });
    expect(out).toMatchObject({ inputTokens: 100, outputTokens: 50 });
    const params = stub.generateContent.mock.calls[0][0] as { model: string; config: Record<string, unknown> };
    expect(params.model).toBe("gemini-3.8-flash");
    expect(params.config).toMatchObject({ systemInstruction: "SYS", maxOutputTokens: 1234, responseMimeType: "application/json", thinkingConfig: { thinkingLevel: "LOW" } });
  });

  it("uses Claude without sampling overrides, turns thinking off for claude-sonnet-5-5, and reads a fenced JSON answer", async () => {
    const stub = claudeStub((user) => `\`\`\`json\n${frenchOf(user)}\n\`\`\``);
    const haiku = createJsonCompleter("claude", "claude-haiku-4-5", {}, { claudeClient: stub.client });
    await haiku.complete({ system: "SYS", user: JSON.stringify({ a: { en: "Hello" } }), maxOutputTokens: 5000 });
    expect(stub.create.mock.calls[0][0]).toMatchObject({ model: "claude-haiku-4-5", max_tokens: 5000, system: "SYS" });
    expect(stub.create.mock.calls[0][0]).not.toHaveProperty("temperature");
    const sonnet = createJsonCompleter("claude", DEFAULT_I18N_MODELS.claude, {}, { claudeClient: stub.client });
    expect(DEFAULT_I18N_MODELS.claude).toBe("claude-sonnet-5-5");
    const out = await sonnet.complete({ system: "SYS", user: JSON.stringify({ a: { en: "Hello" } }), maxOutputTokens: 5000 });
    const body = stub.create.mock.calls[1][0] as Record<string, unknown>;
    expect(body).toMatchObject({ model: "claude-sonnet-5-5", thinking: { type: "between_tools" } });
    expect(body).not.toHaveProperty("temperature");
    // Also parse answers wrapped in code fences.
    const res = await translateMessages({
      locale: "fr",
      source: en,
      reference: { $schema: "s", a: "こんにちは {name}", b: "保存", c: "変更を取り消す" },
      keys: ["a", "b"],
      complete: sonnet.complete,
      glossary: glossaryFor("fr"),
    });
    expect(res.failed).toEqual({});
    expect(res.translated).toEqual({ a: "[fr] Hello {name}", b: "[fr] Save" });
    expect(out.inputTokens).toBe(100);
  });

  it("refuses without the key of the engine (a configuration error before any call), and has a fake engine whose output is valid in every language", async () => {
    expect(() => createJsonCompleter("gemini", "m", {})).toThrow("GEMINI_API_KEY is not set");
    expect(() => createJsonCompleter("claude", "m", { GEMINI_API_KEY: "g" })).toThrow("ANTHROPIC_API_KEY is not set");
    const fake = createJsonCompleter("fake", "fake-i18n", {});
    // Fake-engine translations pass input, newline, script and writing-system validation in all seven languages.
    for (const locale of TARGET_LOCALES) {
      const res = await translateMessages({ locale, source: en, reference: { $schema: "s", a: "あ", b: "い", c: "う" }, keys: ["a", "b", "c"], complete: fake.complete, glossary: glossaryFor(locale) });
      expect(res.failed, locale).toEqual({});
      expect(res.translated.a, locale).toContain("{name}");
    }
  });
});

describe("the native-speaker check (unverified) of machine-translated messages", () => {
  const fr = { $schema: "s", a: "Bonjour {name}", b: "Enregistrer", c: "Annuler les modifications" };

  it("counts a translated key as unverified until the check of exactly that text is recorded; a changed text is unverified again; an absent translation is neither", () => {
    expect(unverifiedKeys(en, fr, undefined)).toEqual(["a", "b", "c"]);
    const first = markVerified({}, "fr", en, fr, ["a", "b"]);
    expect(first.marked).toEqual(["a", "b"]);
    expect(unverifiedKeys(en, fr, first.verified.fr)).toEqual(["c"]);
    // Changing verified text through machine replacement or human correction makes it unverified again.
    expect(unverifiedKeys(en, { ...fr, b: "Sauvegarder" }, first.verified.fr)).toEqual(["b", "c"]);
    // Missing translations are neither counted nor recorded as reviewed.
    const absent = { $schema: fr.$schema, a: fr.a, b: fr.b };
    expect(unverifiedKeys(en, absent, first.verified.fr)).toEqual([]);
    const skipped = markVerified({}, "fr", en, absent, ["a", "c", "nope"]);
    expect(skipped.marked).toEqual(["a"]);
    expect(skipped.skipped).toEqual(["c", "nope"]);
    // Per-language counts.
    expect(unverifiedCounts(en, { fr, de: fr }, { fr: first.verified.fr }, ["fr", "de"])).toEqual({ fr: 1, de: 3 });
  });

  it("writes only the checks that still match the current text, in the order of the source keys, and reads them back", () => {
    const verified = { fr: { b: fingerprint("Enregistrer"), a: fingerprint("OLD TEXT"), zzz: fingerprint("x") } };
    const text = serializeVerified(verified, en, { fr }, ["fr"]);
    expect(JSON.parse(text).$comment).toContain("native speaker");
    expect(parseVerified(text)).toEqual({ fr: { b: fingerprint("Enregistrer") } });
    expect(parseVerified(text).fr).not.toHaveProperty("a");
    expect(Object.keys(JSON.parse(text))).toEqual(["$comment", "fr"]);
  });

  it("keeps who checked a language and when (the log of checks of each language), and writes nothing for a language without a check", () => {
    const first = addCheck({}, "fr", { by: "Marie", at: "2026-10-05", keys: 3 });
    const second = addCheck(first, "fr", { by: "Paul", at: "2026-10-09", keys: 1 });
    expect(first.fr).toHaveLength(1);
    const text = serializeVerified({ fr: { b: fingerprint("Enregistrer") } }, en, { fr }, ["fr", "de"], second);
    expect(Object.keys(JSON.parse(text))).toEqual(["$comment", "$checks", "fr", "de"]);
    expect(parseChecks(text)).toEqual({ fr: [{ by: "Marie", at: "2026-10-05", keys: 3 }, { by: "Paul", at: "2026-10-09", keys: 1 }] });
    // Read verification files even without a reviewer record.
    expect(parseChecks(serializeVerified({}, en, { fr }, ["fr"]))).toEqual({});
    expect(parseChecks(JSON.stringify({ $checks: { fr: [{ by: 1 }, "x", { by: "A", at: "d", keys: 2 }], de: "no" } }))).toEqual({ fr: [{ by: "A", at: "d", keys: 2 }] });
    // Changed translation text loses its verified fingerprint, but the reviewer record remains.
    expect(parseVerified(serializeVerified({ fr: { b: fingerprint("old") } }, en, { fr }, ["fr"], second))).toEqual({ fr: {} });
  });
});

describe("pnpm i18n:translate with the engine and model options, and the native-speaker check", () => {
  const complete = Object.fromEntries(ALL_LOCALES.filter((l) => l !== "en").map((l) => [l, { $schema: "s", a: `[${l}] {name}`, b: `[${l}]`, c: `[${l}] cancel` }]));

  async function withDir<T>(fn: (dir: string, exec: (args: string[], env?: Record<string, string>) => Promise<CliResult>) => Promise<T>): Promise<T> {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "i18n-engine-"));
    try {
      for (const [locale, messages] of Object.entries({ en, ...complete })) fs.writeFileSync(path.join(dir, `${locale}.json`), JSON.stringify(messages));
      // All keys are empty; real calls are impossible unless a fake key is explicitly supplied.
      const base = { ...process.env, I18N_MESSAGES_DIR: dir, GEMINI_API_KEY: "", ANTHROPIC_API_KEY: "", TRANSLATION_PRIMARY: "", I18N_MODEL: "" };
      const exec = async (args: string[], env: Record<string, string> = {}) => (await invokeI18n([...args], { ...base, ...env }));
      expect((await exec(["--init-hashes"])).status).toBe(0);
      return await fn(dir, exec);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  const read = (dir: string, locale: string) => JSON.parse(fs.readFileSync(path.join(dir, `${locale}.json`), "utf8")) as Record<string, string>;
  const touchEnglish = (dir: string) => fs.writeFileSync(path.join(dir, "en.json"), JSON.stringify({ ...en, b: "Save changes" }));

  it("chooses the engine and the model: the configured primary by default, --engine and --model to override, with the price of that model in the estimate (--dry-run calls nothing)", { timeout: 180_000 }, async () => {
    (await withDir(async (dir, exec) => {
      touchEnglish(dir);
      // Default without keys is fake primary: stop and request a key; --dry-run succeeds.
      const none = (await exec(["--stale"]));
      expect(none.status).toBe(1);
      expect(none.stderr).toContain("GEMINI_API_KEY is not set");
      expect(none.stderr).toContain("--allow-fake");
      // Gemini is default when GEMINI_API_KEY exists.
      const gem = (await exec(["--stale", "--dry-run", "--lang", "fr"], { GEMINI_API_KEY: "k" }));
      expect(gem.status, gem.stderr).toBe(0);
      expect(gem.stdout).toContain("engine gemini, model gemini-3.8-flash");
      // TRANSLATION_PRIMARY=claude makes the primary engine the default.
      const primary = (await exec(["--stale", "--dry-run", "--lang", "fr"], { TRANSLATION_PRIMARY: "claude", ANTHROPIC_API_KEY: "a" }));
      expect(primary.stdout).toContain("engine claude, model claude-sonnet-5-5");
      // --engine and --model
      const claude = (await exec(["--stale", "--dry-run", "--lang", "fr", "--engine", "claude", "--model", "claude-opus-5-5"], { GEMINI_API_KEY: "k" }));
      expect(claude.status, claude.stderr).toBe(0);
      expect(claude.stdout).toContain("engine claude, model claude-opus-5-5");
      // Estimates differ by price-table model: Sonnet 5.5 is $2/$10; Opus 5.5 is $4/$20.
      const cost = (out: string) => Number(/about \$([0-9.]+) before/.exec(out)![1]);
      const sonnet = (await exec(["--stale", "--dry-run", "--engine", "claude", "--model", "claude-sonnet-5-5"]));
      const opus = (await exec(["--stale", "--dry-run", "--engine", "claude", "--model", "claude-opus-5-5"]));
      expect(cost(opus.stdout)).toBeGreaterThanOrEqual(cost(sonnet.stdout));
      // I18N_MODEL overrides the engine default model; --model overrides both.
      expect((await exec(["--stale", "--dry-run", "--lang", "fr"], { GEMINI_API_KEY: "k", I18N_MODEL: "gemini-3.1-flash-lite" })).stdout).toContain("model gemini-3.1-flash-lite");
      expect((await exec(["--stale", "--dry-run", "--lang", "fr", "--model", "gemini-3.5-flash-lite"], { GEMINI_API_KEY: "k", I18N_MODEL: "gemini-3.1-flash-lite" })).stdout).toContain("model gemini-3.5-flash-lite");
      // Reject model names from another provider.
      const mismatch = (await exec(["--stale", "--dry-run", "--engine", "claude", "--model", "gemini-3.5-flash"]));
      expect(mismatch.status).toBe(1);
      expect(mismatch.stderr).toContain('"gemini-3.5-flash" is not a claude model');
      // Actual translation requires the selected engine's key; fail before calling and leave files unchanged.
      const noClaudeKey = (await exec(["--stale", "--engine", "claude"], { GEMINI_API_KEY: "k" }));
      expect(noClaudeKey.status).toBe(1);
      expect(noClaudeKey.stderr).toContain("ANTHROPIC_API_KEY is not set");
      expect(read(dir, "fr").b).toBe("[fr]");
      // Unknown engine.
      expect((await exec(["--stale", "--engine", "openai"])).status).toBe(1);
    }));
  });

  it("with --engine fake --allow-fake it fills absent keys through the LLM layer, records source fingerprints and leaves other translations unchanged", { timeout: 240_000 }, async () => {
    (await withDir(async (dir, exec) => {
      const updated = { ...en, d: en.a };
      fs.writeFileSync(path.join(dir, "en.json"), JSON.stringify(updated));
      fs.writeFileSync(path.join(dir, "ja.json"), JSON.stringify({ ...complete.ja, d: complete.ja.a }));
      expect((await exec(["--stamp", "d", "--lang", "ja"])).status).toBe(0);
      const before = read(dir, "fr");
      expect(before).not.toHaveProperty("d");
      expect((await exec(["--check", "--lang", "fr,ko"])).status).toBe(0);
      const refused = (await exec(["--lang", "fr,ko", "--engine", "fake"]));
      expect(refused.status).toBe(1);
      expect(read(dir, "fr")).toEqual(before);
      const run = (await exec(["--lang", "fr,ko", "--engine", "fake", "--allow-fake"]));
      expect(run.status, run.stderr).toBe(0);
      const hashes = JSON.parse(fs.readFileSync(path.join(dir, ".source-hashes.json"), "utf8"));
      for (const locale of ["fr", "ko"]) {
        const after = read(dir, locale);
        expect(after.d).not.toBe(updated.d);
        expect(after.d).toContain("{name}");
        expect(hashes[locale].d).toBe(fingerprint(updated.d));
        for (const [key, value] of Object.entries(complete[locale])) expect(after[key]).toBe(value);
      }
      expect((await exec(["--check", "--strict", "--lang", "fr,ko"])).status).toBe(0);
      expect(read(dir, "de")).not.toHaveProperty("d");
      expect((await exec(["--check", "--strict", "--lang", "de"])).status).toBe(1);
    }));
  });

  it("--verify takes exactly one language and a name, and writes nothing otherwise; --check --require-verified counts a language with missing translations as a problem", { timeout: 300_000 }, async () => {
    (await withDir(async (dir, exec) => {
      const file = path.join(dir, ".verified.json");
      // Exit 1 without writes if --lang is absent (all languages), selects multiple languages, or --by is missing or valueless.
      for (const args of [["--verify", "--all", "--by", "Marie"], ["--verify", "--all", "--lang", "fr,de", "--by", "Marie"], ["--verify", "--all", "--lang", "fr"], ["--verify", "--all", "--lang", "fr", "--by"], ["--verify", "--all", "--lang", "fr", "--by", "--all"]]) {
        const res = (await exec(args));
        expect(res.status, args.join(" ")).toBe(1);
        expect(fs.existsSync(file), `${args.join(" ")} wrote the record`).toBe(false);
      }
      expect((await exec(["--verify", "--all", "--lang", "fr,de", "--by", "Marie"])).stderr).toContain("exactly one language");
      expect((await exec(["--verify", "--all", "--lang", "fr"])).stderr).toContain("--by");
      // One language and a reviewer name succeed.
      expect((await exec(["--verify", "--all", "--lang", "fr", "--by", "Marie Dupont"])).status).toBe(0);
      expect(JSON.parse(fs.readFileSync(file, "utf8")).$checks.fr[0]).toMatchObject({ by: "Marie Dupont", keys: 3 });
      // Missing translations stay outside verification counts but fail the completeness gate.
      fs.writeFileSync(path.join(dir, "en.json"), JSON.stringify({ ...en, e: en.a, f: en.b }));
      fs.writeFileSync(path.join(dir, "ja.json"), JSON.stringify({ ...complete.ja, e: complete.ja.a, f: complete.ja.b }));
      expect((await exec(["--stamp", "e", "f", "--lang", "ja"])).status).toBe(0);
      const missing = (await exec(["--check", "--require-verified", "--lang", "de"]));
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain("de/e: missing");
      expect((await exec(["--check", "--require-verified", "--lang", "fr"])).status).toBe(1);
      expect((await exec(["--check", "--lang", "de"])).status).toBe(0);
    }));
  });

  it("--verify records the check of a language (or of some keys); --check --require-verified fails until a language is fully checked, and a re-translation makes the key unverified again", { timeout: 300_000 }, async () => {
    (await withDir(async (dir, exec) => {
      const counts = async () => /unverified \([^)]*\): ([^\n]*)\n/.exec((await exec(["--check", "--lang", "fr,de"])).stdout)?.[1] ?? "";
      expect((await counts())).toBe("fr 3, de 3");
      // Without verification records, --require-verified reports problems by language and key.
      const strict = (await exec(["--check", "--require-verified", "--lang", "fr"]));
      expect(strict.status).toBe(1);
      expect(strict.stderr).toContain("fr/a: unverified");
      // --verify requires either --all or specific keys.
      expect((await exec(["--verify", "--lang", "fr", "--by", "Marie"])).status).toBe(1);
      expect((await exec(["--verify", "--all", "a", "--lang", "fr", "--by", "Marie"])).status).toBe(1);
      expect((await exec(["--verify", "nope", "--lang", "fr", "--by", "Marie"])).status).toBe(1);
      // Specific keys only.
      const some = (await exec(["--verify", "a", "b", "--lang", "fr", "--by", "Marie"]));
      expect(some.status, some.stderr).toBe(0);
      expect(some.stdout).toMatch(/fr: recorded the native-speaker check of 2 key\(s\) by Marie on \d{4}-\d{2}-\d{2}/);
      expect((await counts())).toBe("fr 1, de 3");
      // The whole language.
      expect((await exec(["--verify", "--all", "--lang", "fr", "--by", "Marie"])).status).toBe(0);
      expect((await counts())).toBe("fr 0, de 3");
      const frDone = (await exec(["--check", "--require-verified", "--lang", "fr"]));
      expect(frDone.status).toBe(0);
      expect(frDone.stderr).toBe("");
      // Record fingerprints of verified strings by language; other languages remain unverified.
      const file = JSON.parse(fs.readFileSync(path.join(dir, ".verified.json"), "utf8")) as Record<string, Record<string, string>>;
      expect(Object.keys(file.fr)).toEqual(["a", "b", "c"]);
      // Keep consecutive reviewer/date records per language for both key-specific and whole-language verification.
      const withChecks = JSON.parse(fs.readFileSync(path.join(dir, ".verified.json"), "utf8")) as { $checks: Record<string, Array<{ by: string; at: string; keys: number }>> };
      expect(Object.keys(withChecks.$checks)).toEqual(["fr"]);
      expect(withChecks.$checks.fr.map((c) => [c.by, c.keys])).toEqual([["Marie", 2], ["Marie", 3]]);
      expect(withChecks.$checks.fr[0].at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect((await exec(["--check", "--lang", "fr"])).stdout).toMatch(/last native-speaker check: fr Marie \d{4}-\d{2}-\d{2}/);
      expect(file.fr.b).toBe(fingerprint("[fr]"));
      expect(file.de).toEqual({});
      // Editing the source and replacing its machine translation makes the replaced key unverified again; other verified keys stay verified.
      touchEnglish(dir);
      const rerun = (await exec(["--stale", "--lang", "fr", "--engine", "fake", "--allow-fake"]));
      expect(rerun.status, rerun.stderr).toBe(0);
      expect(read(dir, "fr").b).toBe("[fr] Save changes");
      expect((await counts())).toBe("fr 1, de 3");
      const check = (await exec(["--check", "--require-verified", "--lang", "fr"]));
      expect(check.status).toBe(1);
      expect(check.stderr).toContain("fr/b: unverified");
      expect(check.stderr).not.toContain("fr/a: unverified");
      // Recording verification makes no API calls, so fake keys work. Do not record missing keys.
      fs.writeFileSync(path.join(dir, "en.json"), JSON.stringify({ ...en, b: "Save changes", e: "Another one" }));
      const verify = (await exec(["--verify", "--all", "--lang", "fr", "--by", "Marie"], { GEMINI_API_KEY: "not-a-real-key" }));
      expect(verify.status).toBe(0);
      expect(verify.stdout).toContain("1 key(s) not recorded");
      expect((await counts())).toBe("fr 0, de 3");
    }));
  });
});
