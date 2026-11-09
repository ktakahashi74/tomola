import { createHash } from "node:crypto";
import { LANGS, type Lang } from "~/lib/languages";
import { LlmError } from "./errors.server";
import { costMicro } from "./pricing.server";
import { estimateTokens, translationSystemPrompt } from "./prompt.server";
import type { ThinkingSetting } from "./thinking";
import { translateChecked } from "./translate.server";
import type { EngineId, GlossaryHint, LlmEnv, TranslationEngine } from "./types";

// Compare translation models (`pnpm translations:compare`; scripts/compare-translations.ts and app/lib/llm/compare-cli.server.ts). Translate the same text with two models of one provider and produce side-by-side output for human readers.
// Select primary (TRANSLATION_GEMINI_MODEL) and retry (TRANSLATION_RETRY_MODEL) models using reviewers who can assess the chosen target languages.
// Review Simplified and Traditional Chinese separately. Uses the production prompt through translateChecked: TARGET_LANG_SPECS script instructions, structure/link checks and one retry.
// Does not touch the DB or budget ledger (no llm_usage rows). Engines are passed in; tests use fakes.

export type CompareItem = {
  id: string;
  lang: Lang;
  title?: string;
  body: string;
  // Optional context: a parent-post excerpt for replies.
  context?: string;
  // Target language for this item, defaulting to the overall to. Directory input can choose per text, e.g. Japanese to English and English to Japanese.
  to?: readonly Lang[];
  // Item metadata copied unchanged to output (directory-input frontmatter: kind, length, source, note, etc.). Not used for translation.
  meta?: Record<string, unknown>;
};

export type CompareSide = {
  // A or B, in the order the two compared models were specified.
  slot: "A" | "B";
  engine: EngineId;
  model: string;
  title: string | null;
  body: string | null;
  // Failure reason, with null translation. Errors may contain model names: exclude from blind Markdown for participants and write only to blind-key.json.
  error: string | null;
  // Structure-check flags: structure_mismatch, link_mismatch, untranslated.
  flags: string[];
  // Engine-call count for title/body, including check-triggered retries, and whether a retry occurred.
  attempts: number;
  retried: boolean;
  inputTokens: number;
  // Includes the thinking tokens.
  outputTokens: number;
  // The thinking tokens inside outputTokens (Gemini only; 0 otherwise), and the thinking level that was sent (null: not reported).
  thoughtTokens: number;
  thinking: string | null;
  costUsdMicro: number;
};

export type CompareEntry = {
  itemId: string;
  from: Lang;
  to: Lang;
  title: string | null;
  body: string;
  // Glossary entries supplied for the body, with production matching rules; empty when absent.
  hints: GlossaryHint[];
  // Item metadata (CompareItem.meta).
  meta: Record<string, unknown> | null;
  // Output order, randomly swapped per pair in blind mode. sides[0] is left (first translation); sides[1] is right.
  sides: [CompareSide, CompareSide];
  // True if blind mode swapped the sides (sides[0] is B).
  swapped: boolean;
};

export type CompareOutput = {
  entries: CompareEntry[];
  // thinking: the GEMINI_TRANSLATION_THINKING setting of a Gemini engine.
  models: { A: { engine: EngineId; model: string; thinking?: ThinkingSetting }; B: { engine: EngineId; model: string; thinking?: ThinkingSetting } };
  blind: boolean;
  seed: number | null;
};

// A value in [0,1) determined by (seed, text, language). Reproduces swaps for the same seed regardless of processing order.
function unit(seed: number, itemId: string, to: string): number {
  const digest = createHash("sha256").update(`${seed}\n${itemId}\n${to}`).digest();
  return digest.readUInt32BE(0) / 2 ** 32;
}

export type CompareOptions = {
  items: readonly CompareItem[];
  // Target languages. Skip the item's original language.
  to: readonly Lang[];
  engines: readonly [TranslationEngine, TranslationEngine];
  // Glossary lookup for production-equivalent comparison: returns entries occurring in the source text.
  glossary?: (from: Lang, to: Lang, text: string) => GlossaryHint[];
  // Randomly swap A/B per pair, omitting model names to blind readers. Reproducible with seed.
  blind?: boolean;
  seed?: number;
  // Environment variables for price estimates (LLM_PRICE_<name>).
  env?: LlmEnv;
  // Called after each text × language pair completes, for progress reporting.
  onProgress?: (done: number, total: number, entry: CompareEntry) => void;
};

async function translateSide(slot: "A" | "B", engine: TranslationEngine, item: CompareItem, to: Lang, glossary: (text: string) => GlossaryHint[], env: LlmEnv | undefined): Promise<CompareSide> {
  const side: CompareSide = { slot, engine: engine.id, model: engine.model, title: null, body: null, error: null, flags: [], attempts: 0, retried: false, inputTokens: 0, outputTokens: 0, thoughtTokens: 0, thinking: null, costUsdMicro: 0 };
  // Count usage and cost per call, including charged responses from failures (refusals/truncated output: LlmError.usage), so failed comparisons retain their cost.
  const count = (usage: { inputTokens: number; outputTokens: number; thoughtTokens?: number; thinking?: string }) => {
    side.attempts += 1;
    side.inputTokens += usage.inputTokens;
    side.outputTokens += usage.outputTokens;
    side.thoughtTokens += usage.thoughtTokens ?? 0;
    if (usage.thinking) side.thinking = usage.thinking;
    side.costUsdMicro += costMicro(engine.id, engine.model, usage.inputTokens, usage.outputTokens, env);
  };
  const metered: TranslationEngine = {
    id: engine.id,
    model: engine.model,
    async translate(req) {
      try {
        const result = await engine.translate(req);
        count(result);
        return result;
      } catch (error) {
        if (error instanceof LlmError && error.usage) count(error.usage);
        throw error;
      }
    },
  };
  const run = async (text: string, withContext: boolean) => {
    const out = await translateChecked(metered, { text, from: item.lang, to, ...(withContext ? { ...(item.title ? { title: item.title } : {}), ...(item.context ? { context: item.context } : {}) } : {}), glossary: glossary(text) });
    if (out.attempts > 1) side.retried = true;
    for (const flag of out.flags) if (!side.flags.includes(flag)) side.flags.push(flag);
    return out.text;
  };
  try {
    if (item.title && item.title.trim() !== "") side.title = await run(item.title, false);
    side.body = await run(item.body, true);
  } catch (error) {
    side.error = error instanceof Error ? error.message : String(error);
    side.body = null;
    side.title = null;
  }
  return side;
}

export async function compareTranslations(opts: CompareOptions): Promise<CompareOutput> {
  const [engineA, engineB] = opts.engines;
  const seed = opts.seed ?? 0;
  const blind = opts.blind === true;
  const pairs = opts.items.flatMap((item) => (item.to ?? opts.to).filter((to) => to !== item.lang).map((to) => ({ item, to })));
  const entries: CompareEntry[] = [];
  for (const { item, to } of pairs) {
    const glossary = (text: string) => opts.glossary?.(item.lang, to, text) ?? [];
    // Translate the same text with both models concurrently. Side order follows result insertion, not call order.
    const [a, b] = await Promise.all([translateSide("A", engineA, item, to, glossary, opts.env), translateSide("B", engineB, item, to, glossary, opts.env)]);
    const swapped = blind && unit(seed, item.id, to) < 0.5;
    const entry: CompareEntry = { itemId: item.id, from: item.lang, to, title: item.title ?? null, body: item.body, hints: glossary(item.body), meta: item.meta ?? null, sides: swapped ? [b, a] : [a, b], swapped };
    entries.push(entry);
    opts.onProgress?.(entries.length, pairs.length, entry);
  }
  return {
    entries,
    models: {
      A: { engine: engineA.id, model: engineA.model, ...(engineA.thinkingSetting ? { thinking: engineA.thinkingSetting } : {}) },
      B: { engine: engineB.id, model: engineB.model, ...(engineB.thinkingSetting ? { thinking: engineB.thinkingSetting } : {}) },
    },
    blind,
    seed: blind ? seed : null,
  };
}

// ---- Output ----

// Table-cell text: newlines become <br>, pipes become \|. Preserve Markdown so readers can compare formatting.
const cell = (text: string | null, title: string | null, empty = "—") => {
  const parts: string[] = [];
  if (title) parts.push(`**${title.replace(/\s*\n\s*/g, " ")}**`);
  if (text) parts.push(text.replace(/\r\n/g, "\n").trim());
  const joined = parts.join("\n\n");
  if (joined === "") return empty;
  return joined.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
};

const usd = (micro: number) => `$${(micro / 1e6).toFixed(4)}`;

// Markdown comparison for one language. Blind mode omits model names, costs and token counts.
export function renderCompareMarkdown(out: CompareOutput, opts: { lang?: Lang } = {}): string {
  const entries = out.entries.filter((e) => opts.lang === undefined || e.to === opts.lang);
  const lines: string[] = [];
  lines.push(`# Translation comparison${opts.lang ? ` (${opts.lang})` : ""}`, "");
  if (out.blind) {
    lines.push("Two translations of each text are shown, in a random order. Which model made which is not shown. For each text, say which one reads better to you (or that they are about the same), and mark mistakes of meaning, word choice and register.", "");
  } else {
    lines.push(
      `Model A: ${out.models.A.engine} / ${out.models.A.model}${out.models.A.thinking ? ` (thinking ${out.models.A.thinking})` : ""}. Model B: ${out.models.B.engine} / ${out.models.B.model}${out.models.B.thinking ? ` (thinking ${out.models.B.thinking})` : ""}.`,
      "",
    );
  }
  for (const entry of entries) {
    const [left, right] = entry.sides;
    const head = out.blind ? ["Translation 1", "Translation 2"] : [`${left.slot}: ${left.model}`, `${right.slot}: ${right.model}`];
    lines.push(`## ${entry.itemId} · ${entry.from} → ${entry.to}`, "");
    lines.push(`| Original (${entry.from}) | ${head[0]} | ${head[1]} |`, "| --- | --- | --- |");
    // Blind mode omits failure reasons, which may expose model names; show only 「失敗」 and record the reason in blind-key.json.
    const side = (s: CompareSide) => (s.error ? (out.blind ? "(translation failed)" : `(failed: ${s.error.replace(/\s+/g, " ")})`.replace(/\|/g, "\\|")) : cell(s.body, s.title));
    lines.push(`| ${cell(entry.body, entry.title)} | ${side(left)} | ${side(right)} |`, "");
    const marks = ([[1, left], [2, right]] as const).filter(([, s]) => s.flags.length > 0 || s.retried);
    if (marks.length > 0) {
      // Structure-check flags disclose only the flag, not the model name.
      lines.push(
        ...marks.map(([n, s]) => `- ${out.blind ? `Translation ${n}` : s.slot}: ${s.flags.length > 0 ? `check marks: ${s.flags.join(", ")}` : "needed a second attempt"}${s.retried && s.flags.length > 0 ? " (after a second attempt)" : ""}`),
        "",
      );
    }
    if (!out.blind) {
      lines.push(...[left, right].map((s) => `- ${s.slot}: ${s.engine} / ${s.model}, ${s.inputTokens} input and ${s.outputTokens} output tokens${s.thoughtTokens > 0 ? ` (${s.thoughtTokens} of them thinking)` : ""}, ${usd(s.costUsdMicro)}`), "");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

// ---- Per-text output (--per-text, for giving directory-input readers one text at a time) ----

// Per-text filename: `<id>-<source-lang>-<target-lang>.md`; numeric-only ids are padded to two digits.
export function perTextFileName(entry: Pick<CompareEntry, "itemId" | "from" | "to">): string {
  const id = /^\d+$/.test(entry.itemId) ? entry.itemId.padStart(2, "0") : entry.itemId.replace(/[^\p{L}\p{N}_-]+/gu, "_");
  return `${id}-${entry.from}-${entry.to}.md`;
}

// Markdown containing one original and two translations under separate headings. Blind mode omits model names, cost, failure reasons and check flags; failures show only `(translation failed)`.
// Keep bodies as Markdown for readers to inspect formatting. Separate sections with headings and horizontal rules.
export function renderCompareText(out: CompareOutput, entry: CompareEntry): string {
  const [left, right] = entry.sides;
  const lines: string[] = [`# ${entry.itemId} · ${entry.from} → ${entry.to}`, ""];
  if (out.blind) {
    lines.push("Two translations of this text are shown, in a random order. Which model made which is not shown. Say which one reads better to you (or that they are about the same), and mark mistakes of meaning, word choice and register.", "");
  } else {
    lines.push(`Translation 1 is ${left.slot} (${left.engine} / ${left.model}); Translation 2 is ${right.slot} (${right.engine} / ${right.model}).`, "");
  }
  const section = (heading: string, title: string | null, body: string | null, failed: string | null) => {
    lines.push("---", "", `## ${heading}`, "");
    if (failed) lines.push(failed, "");
    else {
      if (title) lines.push(`**${title.replace(/\s*\n\s*/g, " ")}**`, "");
      lines.push((body ?? "").replace(/\r\n/g, "\n").trim(), "");
    }
  };
  section(`Original (${entry.from})`, entry.title, entry.body, null);
  for (const [n, side] of [[1, left], [2, right]] as const) {
    section(`Translation ${n}`, side.title, side.body, side.error ? (out.blind ? "(translation failed)" : `(failed: ${side.error.replace(/\s+/g, " ")})`) : null);
  }
  if (!out.blind) {
    lines.push("---", "", ...[left, right].map((s) => `- ${s.slot}: ${s.engine} / ${s.model}, ${s.inputTokens} input and ${s.outputTokens} output tokens${s.thoughtTokens > 0 ? ` (${s.thoughtTokens} of them thinking)` : ""}, ${usd(s.costUsdMicro)}${s.flags.length > 0 ? `, check marks: ${s.flags.join(", ")}` : ""}`), "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

const str = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : "");

// Text index for readers. Kind, length and source describe the original; disclose nothing about models.
export function renderCompareIndex(out: CompareOutput): string {
  const lines = ["# Texts", "", "Read the files in any order. In each file, the original comes first, then Translation 1 and Translation 2 (which model made which is not shown).", ""];
  for (const e of out.entries) {
    const bits = [str(e.meta?.kind), str(e.meta?.length), str(e.meta?.source) || str(e.meta?.source_url)].filter((x) => x !== "");
    lines.push(`- [${e.itemId} · ${e.from} → ${e.to}](${perTextFileName(e)})${bits.length > 0 ? `: ${bits.join(", ")}` : ""}`);
  }
  return `${lines.join("\n")}\n`;
}

// Human-readable blind key; do not give to participating readers.
export function renderBlindKeyMarkdown(out: CompareOutput): string {
  const lines = [
    "# Key (not for the readers)",
    "",
    `Model A: ${out.models.A.engine} / ${out.models.A.model}${out.models.A.thinking ? ` (thinking ${out.models.A.thinking})` : ""}. Model B: ${out.models.B.engine} / ${out.models.B.model}${out.models.B.thinking ? ` (thinking ${out.models.B.thinking})` : ""}. Seed: ${out.seed ?? "-"}.`,
    "",
    "| Text | Pair | Translation 1 | Translation 2 |",
    "| --- | --- | --- | --- |",
    ...out.entries.map((e) => {
      const who = (s: CompareSide) => `${s.slot} (${s.model}${out.models[s.slot].thinking ? `, thinking ${out.models[s.slot].thinking}` : ""})`;
      return `| ${e.itemId} | ${e.from} → ${e.to} | ${who(e.sides[0])} | ${who(e.sides[1])} |`;
    }),
  ];
  return `${lines.join("\n")}\n`;
}

export type CompareTotals = Record<"A" | "B", { engine: EngineId; model: string; calls: number; failed: number; flagged: number; inputTokens: number; outputTokens: number; thoughtTokens: number; costUsdMicro: number; thinking?: ThinkingSetting }>;

// Per-model totals for the stderr summary and results file.
export function compareTotals(out: CompareOutput): CompareTotals {
  const totals: CompareTotals = {
    A: { ...out.models.A, calls: 0, failed: 0, flagged: 0, inputTokens: 0, outputTokens: 0, thoughtTokens: 0, costUsdMicro: 0 },
    B: { ...out.models.B, calls: 0, failed: 0, flagged: 0, inputTokens: 0, outputTokens: 0, thoughtTokens: 0, costUsdMicro: 0 },
  };
  for (const entry of out.entries) {
    for (const s of entry.sides) {
      const t = totals[s.slot];
      t.calls += s.attempts;
      if (s.error) t.failed += 1;
      if (s.flags.length > 0) t.flagged += 1;
      t.inputTokens += s.inputTokens;
      t.outputTokens += s.outputTokens;
      t.thoughtTokens += s.thoughtTokens ?? 0;
      t.costUsdMicro += s.costUsdMicro;
    }
  }
  return totals;
}

// Blind side/model key and per-model totals. Operators only; do not give to participating readers.
export function blindKey(out: CompareOutput) {
  return {
    seed: out.seed,
    models: out.models,
    entries: out.entries.map((e) => ({
      id: e.itemId,
      from: e.from,
      to: e.to,
      translation1: e.sides[0].slot,
      translation2: e.sides[1].slot,
      // Failure reasons, omitted from blind Markdown. Omit the key if none failed.
      ...(e.sides.some((s) => s.error) ? { errors: Object.fromEntries(e.sides.filter((s) => s.error).map((s) => [s.slot, s.error])) } : {}),
    })),
    totals: compareTotals(out),
  };
}

// Thinking tokens per call that the estimate adds (the measured values of 2026-10-01: the model's default about 1,700 on average and up to about 2,800 on a short post, LOW 150 to 300
// on a short sentence; the -lite models do not think by default). off adds none.
function assumedThinkingTokens(engine: TranslationEngine): number {
  if (engine.id !== "gemini") return 0;
  const lite = /lite/.test(engine.model);
  if (engine.thinkingSetting === "default") return lite ? 0 : 2_500;
  if (engine.thinkingSetting === "low") return lite ? 300 : 800;
  return 0;
}

// Estimate before calling: call count (excluding failure retries) and tokens. Input uses production instructions/context; output conservatively estimates 1.5 times the original length.
export function estimateCompare(opts: { items: readonly CompareItem[]; to: readonly Lang[]; engines: readonly [TranslationEngine, TranslationEngine]; env?: LlmEnv }) {
  let calls = 0;
  const per = { A: { inputTokens: 0, outputTokens: 0, costUsdMicro: 0 }, B: { inputTokens: 0, outputTokens: 0, costUsdMicro: 0 } };
  for (const item of opts.items) {
    for (const to of (item.to ?? opts.to).filter((l) => l !== item.lang)) {
      const system = estimateTokens(translationSystemPrompt(item.lang, to, "0123456789abcdef"));
      const fields = [item.title && item.title.trim() !== "" ? { text: item.title, context: 0 } : null, { text: item.body, context: (item.title?.length ?? 0) + (item.context?.length ?? 0) }].filter((f) => f !== null);
      for (const f of fields) {
        const input = system + estimateTokens(f.text) + estimateTokens("x".repeat(f.context)) + 60;
        const output = Math.ceil(estimateTokens(f.text) * 1.5);
        calls += 2;
        (["A", "B"] as const).forEach((slot, i) => {
          const engine = opts.engines[i];
          const total = output + assumedThinkingTokens(engine);
          per[slot].inputTokens += input;
          per[slot].outputTokens += total;
          per[slot].costUsdMicro += costMicro(engine.id, engine.model, input, total, opts.env);
        });
      }
    }
  }
  return { calls, per, totalCostUsdMicro: per.A.costUsdMicro + per.B.costUsdMicro };
}

export const COMPARE_DEFAULT_LANGS: readonly Lang[] = ["ja", "en", "fr", "zh-Hans", "zh-Hant"];
export const isCompareLang = (x: string): x is Lang => (LANGS as readonly string[]).includes(x);
