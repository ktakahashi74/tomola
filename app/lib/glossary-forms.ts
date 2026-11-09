// Parse glossary term forms with browser-compatible pure functions. Initial entries (docs/drafts/glossary-initial.yaml) preserve the manuscript's parenthesized terms:
//   - Variants, abbreviations, paraphrases: 「AIアラインメント（AIアライメント）」「汎用人工知能（AGI）」「existential risk (x-risk)」「评测（危险能力评测）」
//   - Notes: 「piratage de la récompense（英語のまま使われることも多い）」
// Store manuscript wording unchanged in glossary_entries so exports reproduce imports (app/lib/glossary-io.server.ts). Interpret parentheses for translation prompts:
// variants become separate candidates and explanations become notes, keeping note text out of target-language candidates. Use the same parsing to match terms in translated source text.
//
// Parentheses: explanatory text in another language is a note (kana for non-Japanese terms; Han characters for English/French terms). Otherwise it is a variant: abbreviation, alternative spelling, or paraphrase.

const KANA = /[぀-ヿ]/u;
const HAN = /\p{Script=Han}/u;

// Text outside parentheses, excluding parentheses/content, and a list of parenthesized contents. No nesting, which the manuscript does not use.
function splitParens(form: string): { base: string; groups: string[] } {
  const groups: string[] = [];
  const base = form.replace(/[（(]([^）)]*)[）)]/gu, (_all, inner: string) => {
    groups.push(inner.trim());
    return "";
  });
  return { base: base.replace(/\s+/g, " ").trim(), groups };
}

// Whether parenthesized content is a note: an explanation in a language other than the term's.
function isAnnotation(inner: string, lang: string | undefined): boolean {
  if (lang === "ja" || lang === undefined) return false;
  if (lang === "zh-Hans" || lang === "zh-Hant") return KANA.test(inner);
  return KANA.test(inner) || HAN.test(inner);
}

export type ParsedForm = {
  // The term itself without parentheses, plus variants split from parenthesized text at separators such as commas.
  forms: string[];
  // Notes: explanations inside parentheses.
  annotations: string[];
};

export function parseGlossaryForm(form: string, lang?: string): ParsedForm {
  const { base, groups } = splitParens(form);
  const forms = base === "" ? [] : [base];
  const annotations: string[] = [];
  for (const inner of groups) {
    if (inner === "") continue;
    if (isAnnotation(inner, lang)) annotations.push(inner);
    else for (const part of inner.split(/[、，,]/u).map((s) => s.trim()).filter(Boolean)) forms.push(part);
  }
  return { forms: [...new Set(forms)], annotations };
}

// Prompt candidates: split variants into separate candidates and return parenthesized explanations as notes. lang is the target candidate language.
export function cleanCandidates(candidates: readonly string[], lang?: string): { candidates: string[]; annotations: string[] } {
  const out: string[] = [];
  const annotations: string[] = [];
  for (const candidate of candidates) {
    const parsed = parseGlossaryForm(candidate, lang);
    out.push(...(parsed.forms.length > 0 ? parsed.forms : [candidate]));
    annotations.push(...parsed.annotations);
  }
  return { candidates: [...new Set(out)], annotations: [...new Set(annotations)] };
}

// Terms matched against the source text, stored in the table's term column. Parse term forms, then split paired terms at 「／」 and " / "
// so 「inner alignment / outer alignment」 becomes two terms. Pass candidates as the pair 「内部アラインメント／外部アラインメント」.
export function matchTermsOf(form: string, lang?: string): string[] {
  return [...new Set(parseGlossaryForm(form, lang).forms.flatMap((f) => f.split(/\s*[／]\s*|\s+\/\s+/u)).map((s) => s.trim()).filter(Boolean))];
}

const LATIN_EDGE = /^[\p{Script=Latin}\p{N}][\s\S]*[\p{Script=Latin}\p{N}]$|^[\p{Script=Latin}\p{N}]$/u;
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Match terms case-insensitively. Terms starting/ending with Latin letters use Latin-word boundaries: 「value」 must not match 「evaluate」. Allow plural s/es and adjacent Japanese/Chinese characters.
// For scripts without word boundaries, such as Japanese/Chinese, use substring matching.
export function termAppearsIn(term: string, text: string): boolean {
  const t = term.trim();
  if (t === "") return false;
  if (!LATIN_EDGE.test(t)) return text.toLowerCase().includes(t.toLowerCase());
  // Adjacent Latin letters or digits mean part of another word. Adjacent Japanese/Chinese characters are allowed, as in 「RLHFの話」.
  return new RegExp(`(?<![\\p{Script=Latin}\\p{N}])${escapeRegExp(t)}(?:s|es)?(?![\\p{Script=Latin}\\p{N}])`, "iu").test(text);
}
