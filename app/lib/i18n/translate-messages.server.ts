import { safeErrorText } from "~/lib/error-text.server";
import type { Lang } from "~/lib/languages";
import { targetLangSpec } from "~/lib/llm/lang-specs";
import { LANG_NAMES } from "~/lib/llm/prompt.server";
import type { GlossaryHint } from "~/lib/llm/types";
import { KEEP_TERMS, isMessage, validateMessage, type Message, type Messages } from "./messages";

// Translate interface messages from en source with ja reference (`pnpm i18n:translate`; scripts/i18n-translate.ts).
// Engine calls use injected complete, Gemini in production and a fake in tests. This module only builds prompts, splits batches, validates translations with validateMessage in messages.ts,
// and retries rejected results. Return remaining invalid keys in failed without translations; never save source text as a substitute.

// Failures making further attempts pointless, such as exhausted daily free quota or invalid keys. If complete throws fatal: true, translateMessages immediately rethrows without trying remaining keys
// (onAccepted has already saved accepted translations; rerunning resumes from there).
export class FatalTranslationError extends Error {
  readonly fatal = true;
}

export type Complete = (req: { system: string; user: string; maxOutputTokens: number }) => Promise<{ text: string; inputTokens: number; outputTokens: number }>;

// Per-language style instructions. Chinese script/vocabulary instructions reuse entry translation's TARGET_LANG_SPECS (app/lib/llm/lang-specs.ts).
const STYLE: Partial<Record<Lang, string>> = {
  fr: "Address the reader formally (vous).",
  de: "Address the reader formally (Sie). Capitalise nouns as German requires.",
  ko: "Use the polite formal style (합니다체) for sentences, and short noun or imperative forms for buttons and labels.",
  th: "Use a polite, neutral register. Do not put spaces inside a sentence except where Thai separates clauses.",
  vi: "Use a polite, neutral register and address the reader as 'bạn'.",
};

function glossaryLine(hint: GlossaryHint): string {
  const note = hint.note ? ` (${hint.note})` : "";
  if (hint.keepOriginal) return `- "${hint.term}": keep as written`;
  return `- "${hint.term}" -> ${hint.candidates.map((c) => `"${c}"`).join(" or ")}${note}`;
}

export function systemPrompt(locale: Lang, glossary: GlossaryHint[]): string {
  return [
    `You are a professional software localizer. Translate the user-interface strings of "tomola", a multilingual discussion forum (members write in nine languages and read each other's posts through machine translation), from English into ${LANG_NAMES[locale]}.`,
    "",
    'The user message is a JSON object. Each key is a message id; each value has "en" (the English source, authoritative), "ja" (the product team\'s Japanese translation, only to disambiguate; never translate from it) and sometimes "fix" (what was wrong with your previous answer for that id: correct it).',
    "Return one JSON object that maps every id to its translation, and nothing else: no code fence, no commentary, no extra keys.",
    "",
    "Rules:",
    "1. Keep every {placeholder} exactly as written: same name, same braces. They are replaced by values at run time. Never translate, rename, add or drop one. You may move it to fit the grammar of the language.",
    "2. Keep line breaks exactly as in the source (same number of lines; blank lines stay blank lines). A one-line source stays one line.",
    `3. Keep these terms exactly as written, untranslated, wherever they appear: ${KEEP_TERMS.join(", ")}.`,
    "4. The id tells the context. Short ids such as *_submit, *_title, *_label, *_link, nav_* and field_* are labels, buttons and headings: translate them as labels (the form a button or heading takes in that language), without a final period unless the source has one. Ids with *_help, *_intro, *_note, error_*, notification_* and every full sentence are sentences: translate them as complete, natural sentences in the same register as the source. mail_* ids are plain-text e-mails; keep their structure and put {url} on its own line as in the source.",
    "5. Be faithful. Do not add, remove, soften, strengthen or explain anything. Do not add quotation marks, Markdown or HTML that the source does not have. Keep numbers, symbols and punctuation that carry meaning (for example · and — ) as in the source.",
    `6. ${[STYLE[locale], targetLangSpec(locale)].filter(Boolean).join(" ")}`.trim(),
    "Complex source values are inlang message-format arrays: keep declarations and selectors and return translated match patterns for every cardinal category in the target language (including other). Keep all input placeholders in every branch. Do not turn a plural message into a string.",
    "7. Use this vocabulary consistently. These are recommendations; if one does not fit the context, translate naturally.",
    ...glossary.map(glossaryLine),
  ].join("\n");
}

export type Item = { en: Message; ja?: Message; fix?: string };

export function userPrompt(items: Record<string, Item>): string {
  return JSON.stringify(items, null, 1);
}

// Parse a JSON-string response, optionally code-fenced, into a key/translation map. Null if unparseable.
export function parseResponse(text: string): Record<string, unknown> | null {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const value = JSON.parse(trimmed) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export type TranslateOptions = {
  locale: Lang;
  source: Messages;
  reference: Messages;
  // Keys to translate: present in the source but not yet in this language.
  keys: string[];
  complete: Complete;
  glossary: GlossaryHint[];
  batchSize?: number;
  // Maximum attempts per key until validation passes.
  maxAttempts?: number;
  // Deliver accepted translations per batch for saving, enabling resume after interruption.
  onAccepted?: (accepted: Messages) => void | Promise<void>;
  log?: (message: string) => void;
  // Cost limit: stop before a call if already exceeded. Callers calculate it from usage.
  shouldStop?: () => string | null;
};

export type TranslateResult = {
  translated: Messages;
  // Keys still failing validation and their latest issues.
  failed: Record<string, string[]>;
  calls: number;
  retriedKeys: number;
  inputTokens: number;
  outputTokens: number;
  // Stop reason returned by shouldStop, or null if not stopped.
  stopped: string | null;
};

export async function translateMessages(opts: TranslateOptions): Promise<TranslateResult> {
  const batchSize = opts.batchSize ?? 40;
  const maxAttempts = opts.maxAttempts ?? 3;
  const system = systemPrompt(opts.locale, opts.glossary);
  const result: TranslateResult = { translated: {}, failed: {}, calls: 0, retriedKeys: 0, inputTokens: 0, outputTokens: 0, stopped: null };
  const problemsOf: Record<string, string[]> = {};
  let pending = [...opts.keys];

  for (let attempt = 1; attempt <= maxAttempts && pending.length > 0; attempt++) {
    const next: string[] = [];
    for (let i = 0; i < pending.length; i += batchSize) {
      const batch = pending.slice(i, i + batchSize);
      const stop = opts.shouldStop?.() ?? null;
      if (stop) {
        result.stopped = stop;
        return { ...result, failed: { ...result.failed, ...Object.fromEntries(pending.slice(i).map((k) => [k, problemsOf[k] ?? ["not translated (stopped)"]])) } };
      }
      const items: Record<string, Item> = {};
      for (const key of batch) {
        items[key] = { en: opts.source[key], ...(opts.reference[key] !== undefined ? { ja: opts.reference[key] } : {}), ...(problemsOf[key] ? { fix: problemsOf[key].join("; ") } : {}) };
      }
      if (attempt > 1) result.retriedKeys += batch.length;
      let response: Record<string, unknown> | null = null;
      try {
        const out = await opts.complete({ system, user: userPrompt(items), maxOutputTokens: 60_000 });
        result.calls += 1;
        result.inputTokens += out.inputTokens;
        result.outputTokens += out.outputTokens;
        response = parseResponse(out.text);
        if (response === null) opts.log?.(`${opts.locale}: the response was not a JSON object (attempt ${attempt}); retrying these ${batch.length} keys`);
      } catch (error) {
        if (error instanceof FatalTranslationError) throw error;
        opts.log?.(`${opts.locale}: the call failed (attempt ${attempt}): ${safeErrorText(error)}`);
      }
      const accepted: Messages = {};
      for (const key of batch) {
        const value = response?.[key];
        if (!isMessage(value)) {
          problemsOf[key] = ["no translation was returned for this id"];
          next.push(key);
          continue;
        }
        const problems = validateMessage(opts.source[key], value, { locale: opts.locale, heuristics: true });
        if (problems.length > 0) {
          problemsOf[key] = problems;
          next.push(key);
        } else {
          accepted[key] = value;
          delete problemsOf[key];
        }
      }
      if (Object.keys(accepted).length > 0) {
        Object.assign(result.translated, accepted);
        await opts.onAccepted?.(accepted);
      }
    }
    pending = next;
  }
  for (const key of pending) result.failed[key] = problemsOf[key] ?? ["not translated"];
  return result;
}
