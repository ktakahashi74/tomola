import fs from "node:fs";
import path from "node:path";
import { expandGlossaryFile, parseGlossaryFile, type GlossaryRowData } from "~/lib/glossary-io.server";
import { parse as parseYaml } from "yaml";
import { LANGS, type Lang } from "~/lib/languages";
import { matchGlossary } from "~/lib/translations.server";
import { blindKey, COMPARE_DEFAULT_LANGS, compareTotals, compareTranslations, estimateCompare, perTextFileName, renderBlindKeyMarkdown, renderCompareIndex, renderCompareMarkdown, renderCompareText, type CompareItem, type CompareOutput } from "./compare.server";
import { createEngineForModel, primaryEngineId, translationThinking, type EngineDeps } from "./config.server";
import { THINKING_ENV, THINKING_SETTINGS, type ThinkingSetting } from "./thinking";
import { LlmError } from "./errors.server";
import type { EngineId, GlossaryHint, LlmEnv, TranslationEngine } from "./types";

// Implementation of `pnpm translations:compare`; scripts/compare-translations.ts only calls this. Tests run it with fake engines and in-memory I/O.
//
//   pnpm translations:compare --models <a>,<b> [--thinking <off|low|default>,<off|low|default>] --input <file | dir> [--from <tag>] [--langs <tag>,... | auto] [--out <dir>] [--per-text] [--key-dir <dir>] [--results-json <file>] [--blind] [--seed <n>] [--glossary <file> | --no-glossary] [--dry-run] [--allow-fake] [--max-cost-usd <n>]
//
// --models  Two models from the primary provider (TRANSLATION_PRIMARY, default gemini with GEMINI_API_KEY, otherwise fake). Example: gemini-3.5-flash-lite,gemini-3.8-flash
//           or claude-haiku-4-5,claude-sonnet-5-5. **Match TRANSLATION_PRIMARY to the model provider**: use TRANSLATION_PRIMARY=claude for Claude comparisons. If claude-* or gemini-*
//           names mismatch the primary provider, stop before calls with remediation instructions. For different providers, use <provider>:<model> (gemini:… claude:… fake:…). Keys: GEMINI_API_KEY, ANTHROPIC_API_KEY.
// --thinking  Gemini translation thinking per model: GEMINI_TRANSLATION_THINKING values off, low, default. Example: --thinking off,default.
//           If absent, both use GEMINI_TRANSLATION_THINKING or off. To compare **the same model twice with different settings**, repeat its name in --models and distinguish --thinking
//           (example: --models gemini-3.8-flash,gemini-3.8-flash --thinking off,default). Has no effect on Claude models.
// --glossary  YAML glossary of recommended translations, passed to prompts as in production. Defaults to docs/drafts/glossary-initial.yaml; if absent, report and omit. --no-glossary omits it.
// --input   Texts: JSON array ([{ "id": "t1", "lang": "ja", "title": "…", "body": "…", "context": "…" }]; title/context optional; lang defaults to --from),
//           or Markdown texts separated by lines containing only `---`. --from sets source language; an initial `# Title` line becomes the title.
//           or a directory: one file per text (`NN-<language>-<kind>.md`), with leading YAML frontmatter requiring `id`/`lang`. `kind`, `length`, `source`, `source_url`, `author`, `note`
//           are carried into output only; subsequent text is the body. Translate only body; exclude frontmatter from translation/prompts. Skip `index.md`.
// --from    Source language when text lacks lang. --langs targets, default ja,en,fr,zh-Hans,zh-Hant; skip source-matching targets. `auto` translates Japanese to English and English to Japanese; other sources error.
// --per-text  Instead of compare-<tag>.md language tables, write Markdown per text/target (`<id>-<source>-<target>.md`) with source/translation 1/translation 2 under headings, plus index.md.
// --key-dir   Directory for blind mappings (blind-key.json and readable key.md), default --out. Use to separate mappings from the directory shared with readers.
// --results-json  File for full translation results, including model names even in blind mode and per-text glossary entries. Keep outside --out; never give to readers.
// --out     Output directory: compare-<tag>.md per language (source/A/B in one table row) and results.json (models, tokens, costs, validation flags). Without it, use stdout.
// --blind   Randomly swap A/B per text/language pair, omitting model names/costs from reader output. --seed makes this reproducible.
//           Write mappings/totals separately in blind-key.json; requires --out, never share with participants. Failed translations appear only as 「失敗」 in Markdown because error text may reveal models; details go in blind-key.json.
// --dry-run Estimate calls/costs without calling, then stop. --allow-fake permits fake engines from absent keys or explicit fake. Reject by default to avoid mixing fake output into real model comparisons.
// --max-cost-usd  Stop without calling if the estimate exceeds this, default 2.
// Neither DB nor budget is touched; add no llm_usage rows. For real engines, print call/cost estimates to stderr before calling.

export type CompareCliIo = {
  env: LlmEnv;
  // Directory input: the directory or its filenames when --input is a directory. Without this, directory input is unavailable.
  isDir?(path: string): boolean;
  listDir?(dir: string): string[];
  // File I/O, in-memory in tests.
  readFile(file: string): string;
  writeFile(file: string, text: string): void;
  mkdir(dir: string): void;
  stdout(text: string): void;
  stderr(text: string): void;
  // Engine factory, returning fakes in tests. Defaults to environment variables and createEngineForModel.
  engineFor?: (provider: EngineId, model: string, slot: 0 | 1) => TranslationEngine;
  // Glossary supplied as recommended translations; omitted if absent.
  glossary?: (from: Lang, to: Lang, text: string) => GlossaryHint[];
  deps?: EngineDeps;
};

export const defaultCompareIo = (): CompareCliIo => ({
  env: process.env,
  isDir: (p) => fs.existsSync(p) && fs.statSync(p).isDirectory(),
  listDir: (dir) => fs.readdirSync(dir),
  readFile: (file) => fs.readFileSync(file, "utf8"),
  writeFile: (file, text) => fs.writeFileSync(file, text),
  mkdir: (dir) => void fs.mkdirSync(dir, { recursive: true }),
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
});

export class CompareUsageError extends Error {}

const USAGE =
  "usage: pnpm translations:compare --models <a>,<b> [--thinking <setting>,<setting>] --input <file | dir> [--from <tag>] [--langs <tag>,... | auto] [--out <dir>] [--per-text] [--key-dir <dir>] [--results-json <file>] [--blind] [--seed <n>] [--glossary <file> | --no-glossary] [--dry-run] [--allow-fake] [--max-cost-usd <n>]";

// Default glossary file: production initial entries, relative to working directory.
export const DEFAULT_COMPARE_GLOSSARY = "docs/drafts/glossary-initial.yaml";

export type CompareArgs = {
  models: [string, string];
  // --thinking: the GEMINI_TRANSLATION_THINKING setting of each model (null: the environment's).
  thinking: [ThinkingSetting | null, ThinkingSetting | null];
  input: string;
  from: Lang | null;
  // auto: Japanese texts to English, English texts to Japanese.
  langs: Lang[] | "auto";
  out: string | null;
  perText: boolean;
  keyDir: string | null;
  resultsJson: string | null;
  blind: boolean;
  seed: number;
  // Glossary file, null to omit. glossaryGiven means explicitly supplied through --glossary; otherwise continue without it if unreadable.
  glossary: string | null;
  glossaryGiven: boolean;
  dryRun: boolean;
  allowFake: boolean;
  maxCostUsd: number;
};

export function parseCompareArgs(argv: readonly string[]): CompareArgs {
  const args: CompareArgs = { models: ["", ""], thinking: [null, null], input: "", from: null, langs: [...COMPARE_DEFAULT_LANGS], out: null, perText: false, keyDir: null, resultsJson: null, blind: false, seed: 0, glossary: DEFAULT_COMPARE_GLOSSARY, glossaryGiven: false, dryRun: false, allowFake: false, maxCostUsd: 2 };
  const takeLang = (flag: string, raw: string | undefined): Lang => {
    if (!raw || !(LANGS as readonly string[]).includes(raw)) throw new CompareUsageError(`${flag} takes a language tag: ${LANGS.join(", ")} (got "${raw ?? ""}")`);
    return raw as Lang;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--models") {
      const parts = (argv[++i] ?? "").split(",").map((s) => s.trim());
      if (parts.length !== 2 || parts.some((p) => p === "")) throw new CompareUsageError("--models takes exactly two model names separated by a comma, for example --models gemini-3.5-flash-lite,gemini-3.8-flash");
      args.models = [parts[0], parts[1]];
    } else if (a === "--thinking") {
      const parts = (argv[++i] ?? "").split(",").map((s) => s.trim().toLowerCase());
      if (parts.length !== 2 || parts.some((p) => !(THINKING_SETTINGS as readonly string[]).includes(p))) {
        throw new CompareUsageError(`--thinking takes two settings separated by a comma, one for each model, from: ${THINKING_SETTINGS.join(", ")} (for example --thinking off,default)`);
      }
      args.thinking = [parts[0] as ThinkingSetting, parts[1] as ThinkingSetting];
    } else if (a === "--input") args.input = argv[++i] ?? "";
    else if (a === "--from") args.from = takeLang("--from", argv[++i]);
    else if (a === "--langs" && argv[i + 1]?.trim() === "auto") {
      i++;
      args.langs = "auto";
    } else if (a === "--langs") {
      const wanted = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      if (wanted.length === 0) throw new CompareUsageError(`--langs takes a comma-separated list of: ${LANGS.join(", ")}`);
      args.langs = [...new Set(wanted.map((l) => takeLang("--langs", l)))];
    } else if (a === "--out") args.out = argv[++i] ?? "";
    else if (a === "--per-text") args.perText = true;
    else if (a === "--key-dir") args.keyDir = argv[++i] ?? "";
    else if (a === "--results-json") args.resultsJson = argv[++i] ?? "";
    else if (a === "--blind") args.blind = true;
    else if (a === "--seed") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 0) throw new CompareUsageError("--seed takes a non-negative integer");
      args.seed = n;
    } else if (a === "--glossary") {
      const file = argv[++i] ?? "";
      if (file === "" || file.startsWith("--")) throw new CompareUsageError("--glossary takes a YAML file (the default is docs/drafts/glossary-initial.yaml); --no-glossary turns the glossary off");
      args.glossary = file;
      args.glossaryGiven = true;
    } else if (a === "--no-glossary") args.glossary = null;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--allow-fake") args.allowFake = true;
    else if (a === "--max-cost-usd") {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n <= 0) throw new CompareUsageError("--max-cost-usd takes a positive number");
      args.maxCostUsd = n;
    } else throw new CompareUsageError(`unknown argument: ${a}`);
  }
  if (args.models[0] === "") throw new CompareUsageError("--models is required");
  if (args.input === "") throw new CompareUsageError("--input is required");
  if (args.out === "") throw new CompareUsageError("--out takes a directory");
  if (args.keyDir === "") throw new CompareUsageError("--key-dir takes a directory");
  if (args.resultsJson === "") throw new CompareUsageError("--results-json takes a file");
  if (args.perText && args.out === null) throw new CompareUsageError("--per-text needs --out");
  // In blind mode the key and the results name the model of every translation: they must not sit in the directory that is handed to the readers.
  if (args.blind && args.out !== null) {
    const out = path.resolve(args.out);
    const inside = (p: string) => {
      const rel = path.relative(out, path.resolve(p));
      return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    };
    if (args.keyDir !== null && inside(args.keyDir)) throw new CompareUsageError(`--key-dir ${args.keyDir} is inside --out ${args.out}: with --blind, the key says which model made which translation, so it must be outside the directory that readers get`);
    if (args.resultsJson !== null && inside(args.resultsJson)) throw new CompareUsageError(`--results-json ${args.resultsJson} is inside --out ${args.out}: with --blind, the results name the model of every translation, so they must be outside the directory that readers get`);
  }
  if (args.blind && args.out === null) throw new CompareUsageError("--blind needs --out: the key that says which model made which translation is written to <out>/blind-key.json (or --key-dir), apart from the files that are read");
  return args;
}

// Parse input files into text lists: JSON arrays or Markdown separated by `---`-only lines.
export function parseCompareInput(text: string, from: Lang | null): CompareItem[] {
  const trimmed = text.trim();
  let items: CompareItem[];
  if (trimmed.startsWith("[")) {
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch (error) {
      throw new CompareUsageError(`the input is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!Array.isArray(raw)) throw new CompareUsageError("the JSON input must be an array of texts");
    items = raw.map((entry, index) => {
      const e = (entry ?? {}) as Record<string, unknown>;
      const lang = typeof e.lang === "string" ? e.lang : from;
      if (typeof lang !== "string" || !(LANGS as readonly string[]).includes(lang)) throw new CompareUsageError(`text ${index + 1}: lang is missing or not one of ${LANGS.join(", ")} (set it in the file, or pass --from)`);
      if (typeof e.body !== "string" || e.body.trim() === "") throw new CompareUsageError(`text ${index + 1}: body is missing or empty`);
      for (const key of ["title", "context", "id"]) if (e[key] !== undefined && typeof e[key] !== "string") throw new CompareUsageError(`text ${index + 1}: ${key} must be a string`);
      return {
        id: typeof e.id === "string" && e.id.trim() !== "" ? e.id.trim() : `t${index + 1}`,
        lang: lang as Lang,
        ...(typeof e.title === "string" && e.title.trim() !== "" ? { title: e.title.trim() } : {}),
        body: e.body,
        ...(typeof e.context === "string" && e.context.trim() !== "" ? { context: e.context } : {}),
      };
    });
  } else {
    if (from === null) throw new CompareUsageError("a Markdown input needs --from <tag> (the language of the texts)");
    items = trimmed
      .split(/^---\s*$/m)
      .map((chunk) => chunk.trim())
      .filter((chunk) => chunk !== "")
      .map((chunk, index) => {
        const heading = /^#\s+(.+?)\s*\n+([\s\S]*)$/.exec(chunk);
        return { id: `t${index + 1}`, lang: from, ...(heading ? { title: heading[1] } : {}), body: (heading ? heading[2] : chunk).trim() };
      })
      .filter((item) => item.body !== "");
  }
  if (items.length === 0) throw new CompareUsageError("the input has no text to translate");
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) throw new CompareUsageError(`the id "${item.id}" is used twice in the input`);
    seen.add(item.id);
  }
  return items;
}

// One directory-input file: YAML frontmatter/body. Do not translate frontmatter; return only body. If id is absent, use leading filename digits or the extensionless filename.
export function parseCompareFile(name: string, text: string): CompareItem {
  const m = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!m) throw new CompareUsageError(`the input ${name}: the file must start with a YAML frontmatter between two lines of three hyphens`);
  let meta: unknown;
  try {
    meta = parseYaml(m[1]);
  } catch (error) {
    throw new CompareUsageError(`the input ${name}: the frontmatter is not valid YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) throw new CompareUsageError(`the input ${name}: the frontmatter must be a YAML mapping`);
  const front = meta as Record<string, unknown>;
  const lang = front.lang;
  if (typeof lang !== "string" || !(LANGS as readonly string[]).includes(lang)) throw new CompareUsageError(`the input ${name}: lang in the frontmatter is missing or not one of ${LANGS.join(", ")}`);
  const body = m[2].trim();
  if (body === "") throw new CompareUsageError(`the input ${name}: the body is empty`);
  const fallbackId = /^(\d+)/.exec(name)?.[1] ?? name.replace(/\.md$/i, "");
  const id = typeof front.id === "string" || typeof front.id === "number" ? String(front.id).trim() : fallbackId;
  return { id: id === "" ? fallbackId : id, lang: lang as Lang, body, meta: Object.fromEntries(Object.entries(front).filter(([k]) => k !== "id" && k !== "lang")) };
}

// Directory input: read *.md except index.md in filename order, one text per file.
export function parseCompareDirectory(dir: string, io: Pick<CompareCliIo, "listDir" | "readFile">): CompareItem[] {
  if (!io.listDir) throw new CompareUsageError("the input is a directory, but this environment cannot list directories");
  const names = io
    .listDir(dir)
    .filter((n) => /\.md$/i.test(n) && n.toLowerCase() !== "index.md")
    .sort();
  if (names.length === 0) throw new CompareUsageError(`the input directory ${dir} has no .md file (index.md is skipped)`);
  const items = names.map((n) => parseCompareFile(n, io.readFile(path.join(dir, n))));
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) throw new CompareUsageError(`the id "${item.id}" is used twice in the input`);
    seen.add(item.id);
  }
  return items;
}

// "<provider>:<model>" or "<model>" using the primary provider. If claude-*/gemini-* names mismatch that provider, stop before calls with remediation.
function splitModel(spec: string, defaultProvider: EngineId): { provider: EngineId; model: string } {
  const match = /^(gemini|claude|fake):(.+)$/i.exec(spec);
  if (match) return { provider: match[1].toLowerCase() as EngineId, model: match[2].trim() };
  const named: EngineId | null = /^claude/i.test(spec) ? "claude" : /^(models\/)?gemini/i.test(spec) ? "gemini" : null;
  if (named !== null && named !== defaultProvider) {
    throw new CompareUsageError(
      `--models: "${spec}" is a ${named} model, but the provider here is ${defaultProvider} (TRANSLATION_PRIMARY, or gemini when only GEMINI_API_KEY is set, otherwise fake). ` +
        `Set TRANSLATION_PRIMARY=${named} to compare ${named} models, or write ${named}:${spec} to name the provider in --models.`,
    );
  }
  return { provider: defaultProvider, model: spec };
}

// Build a function returning production-equivalent glossary matches: convert YAML to all directions between five languages and match source text with matchGlossary.
function glossaryFrom(file: string, io: CompareCliIo, given: boolean): { match: (from: Lang, to: Lang, text: string) => GlossaryHint[]; rows: number } | null {
  let text: string;
  try {
    text = io.readFile(file);
  } catch (error) {
    if (given) throw new CompareUsageError(`cannot read the glossary ${file}: ${error instanceof Error ? error.message : String(error)}`);
    io.stderr(`translations:compare: no glossary (${file} was not found); the texts are translated without recommended translations. Pass --glossary <file>, or --no-glossary to silence this.\n`);
    return null;
  }
  const parsed = parseGlossaryFile(text);
  if (!parsed.ok) throw new CompareUsageError(`the glossary ${file} is not valid:\n${parsed.errors.map((e) => `  - ${e}`).join("\n")}`);
  const rows: GlossaryRowData[] = expandGlossaryFile(parsed.file).rows;
  return {
    rows: rows.length,
    match: (from, to, body) =>
      matchGlossary(
        rows.filter((r) => r.lang === from && r.targetLang === to),
        body,
      ),
  };
}

const usd = (micro: number) => `$${(micro / 1e6).toFixed(4)}`;

// The model name, with the thinking setting of a Gemini engine.
const labelOf = (engine: Pick<TranslationEngine, "model" | "thinkingSetting">) => `${engine.model}${engine.thinkingSetting ? ` (thinking ${engine.thinkingSetting})` : ""}`;

// Run and return exit code: 0 success; 1 invalid arguments/configuration or at least one engine failure.
export async function runCompareCli(argv: readonly string[], io: CompareCliIo = defaultCompareIo()): Promise<number> {
  try {
    const args = parseCompareArgs(argv);
    const items = io.isDir?.(args.input) ? parseCompareDirectory(args.input, io) : parseCompareInput(io.readFile(args.input), args.from);
    // --langs auto chooses targets per text: Japanese to English, English to Japanese.
    if (args.langs === "auto") {
      for (const item of items) {
        if (item.lang !== "ja" && item.lang !== "en") throw new CompareUsageError(`--langs auto translates ja texts into en and en texts into ja, but the text ${item.id} is ${item.lang}`);
        item.to = [item.lang === "ja" ? "en" : "ja"];
      }
    }
    const defaultProvider = primaryEngineId(io.env);
    const specs = args.models.map((m) => splitModel(m, defaultProvider));
    // The same model twice is a comparison of two thinking settings: the settings must differ.
    const settingOf = (slot: 0 | 1) => args.thinking[slot] ?? translationThinking(io.env);
    if (specs[0].provider === specs[1].provider && specs[0].model === specs[1].model && (specs[0].provider !== "gemini" || settingOf(0) === settingOf(1))) {
      throw new CompareUsageError("the two models must differ (or be the same Gemini model with two different --thinking settings)");
    }
    const make =
      io.engineFor ??
      ((provider: EngineId, model: string, slot: 0 | 1) =>
        createEngineForModel(provider, model, args.thinking[slot] ? { ...io.env, [THINKING_ENV]: args.thinking[slot]! } : io.env, { ...(io.deps ?? {}), log: (line) => io.stderr(`${line}\n`) }, "--models"));
    const engines = [make(specs[0].provider, specs[0].model, 0), make(specs[1].provider, specs[1].model, 1)] as const;

    // Reject fake engines to prevent fake translations entering real model comparisons.
    if (!args.allowFake && engines.some((e) => e.id === "fake")) {
      throw new CompareUsageError(
        'one of the models is the fake engine (no API key, TRANSLATION_PRIMARY=fake, or "fake:…"): its output would be placeholder translations like "[ja] text". Set the key and the models of the real provider, or pass --allow-fake if the fake engine is what you mean (tests, a dry check of the output).',
      );
    }
    // Glossary: supply recommended translations as in production, enabled by default. Use injected glossary in tests when provided.
    let glossary = io.glossary;
    if (!glossary && args.glossary !== null) {
      const loaded = glossaryFrom(args.glossary, io, args.glossaryGiven);
      if (loaded) {
        glossary = loaded.match;
        io.stderr(`translations:compare: glossary ${args.glossary} (${loaded.rows} rows): the matching entries are passed as recommended translations, as in production.\n`);
      }
    }
    const real = engines.some((e) => e.id !== "fake");
    const targets: Lang[] = args.langs === "auto" ? ["ja", "en"] : args.langs;
    const estimate = estimateCompare({ items, to: targets, engines, env: io.env });
    if (estimate.calls === 0) throw new CompareUsageError("nothing to translate: every text is already in every language asked for (--langs)");
    if (real) {
      io.stderr(
        `translations:compare: ${items.length} text(s), ${args.langs === "auto" ? "ja<->en (auto)" : targets.join(", ")}; ${estimate.calls} call(s) at least (${estimate.calls / 2} per model); estimated cost ` +
          `${usd(estimate.totalCostUsdMicro)} (${labelOf(engines[0])}: ${usd(estimate.per.A.costUsdMicro)}, ${labelOf(engines[1])}: ${usd(estimate.per.B.costUsdMicro)}; from the token estimate and the price table). It does not use the monthly budget (llm_usage).\n`,
      );
      if (estimate.totalCostUsdMicro > args.maxCostUsd * 1e6) {
        throw new CompareUsageError(`the estimate (${usd(estimate.totalCostUsdMicro)}) is over --max-cost-usd ${args.maxCostUsd}. Use fewer texts or languages, or raise the limit.`);
      }
    }
    if (args.dryRun) {
      io.stderr(`--dry-run: nothing was called${real ? "" : " (the fake engine costs nothing)"}.\n`);
      return 0;
    }

    const out = await compareTranslations({
      items,
      to: targets,
      engines,
      glossary,
      blind: args.blind,
      seed: args.seed,
      env: io.env,
      onProgress: (done, total) => {
        if (real) io.stderr(`translations:compare: ${done}/${total}\n`);
      },
    });
    writeOutput(args, out, io);
    const totals = compareTotals(out);
    for (const slot of ["A", "B"] as const) {
      const t = totals[slot];
      io.stderr(`${slot}: ${t.engine} / ${labelOf(t.thinking ? { model: t.model, thinkingSetting: t.thinking } : t)}: ${t.calls} call(s), ${t.inputTokens} input and ${t.outputTokens} output tokens${t.thoughtTokens > 0 ? ` (${t.thoughtTokens} of them thinking)` : ""}, ${usd(t.costUsdMicro)}${t.failed > 0 ? `, ${t.failed} failed` : ""}${t.flagged > 0 ? `, ${t.flagged} with check marks` : ""}\n`);
    }
    return totals.A.failed + totals.B.failed > 0 ? 1 : 0;
  } catch (error) {
    if (error instanceof CompareUsageError || error instanceof LlmError) {
      io.stderr(`${error.message}${error instanceof CompareUsageError && /^(--|unknown argument|the input)/.test(error.message) ? `\n${USAGE}` : ""}\n`);
      return 1;
    }
    throw error;
  }
}

function writeOutput(args: CompareArgs, out: CompareOutput, io: CompareCliIo): void {
  if (args.out === null) {
    io.stdout(renderCompareMarkdown(out));
    return;
  }
  io.mkdir(args.out);
  if (args.perText) {
    for (const entry of out.entries) io.writeFile(path.join(args.out, perTextFileName(entry)), renderCompareText(out, entry));
    io.writeFile(path.join(args.out, "index.md"), renderCompareIndex(out));
  } else {
    const langs = [...new Set(out.entries.map((e) => e.to))];
    for (const lang of langs) io.writeFile(path.join(args.out, `compare-${lang}.md`), renderCompareMarkdown(out, { lang }));
  }
  if (out.blind) {
    // Mappings/totals must not reach reading participants. --key-dir can separate them from the reader-file directory.
    const keyDir = args.keyDir ?? args.out;
    if (keyDir !== args.out) io.mkdir(keyDir);
    io.writeFile(path.join(keyDir, "blind-key.json"), `${JSON.stringify(blindKey(out), null, 2)}\n`);
    if (args.perText) io.writeFile(path.join(keyDir, "key.md"), renderBlindKeyMarkdown(out));
  } else {
    io.writeFile(path.join(args.out, "results.json"), `${JSON.stringify({ models: out.models, totals: compareTotals(out), entries: out.entries }, null, 2)}\n`);
  }
  if (args.resultsJson !== null) {
    const dir = path.dirname(args.resultsJson);
    if (dir !== ".") io.mkdir(dir);
    io.writeFile(args.resultsJson, `${JSON.stringify({ models: out.models, blind: out.blind, seed: out.seed, totals: compareTotals(out), entries: out.entries }, null, 2)}\n`);
  }
}
