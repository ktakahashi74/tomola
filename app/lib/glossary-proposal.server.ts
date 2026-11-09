import type { Db } from "~/lib/db/client.server";
import { getActiveGlossaryEntry } from "~/lib/glossary.server";
import { isLang, languageName, type Lang } from "~/lib/languages";
import { parseIdOrNull } from "~/lib/params.server";
import { m } from "~/paraglide/messages.js";

// The template of a translation proposal. A proposal is an ordinary "asks a stance" post: it has no attribute and no table of its own. All that is added is a path
// that puts initial values into the title and the body of the new-topic screen (/t/new). The entry URLs (made by the links of /glossary):
//   /t/new?asks_stance=1&propose_term=1&entry=<id of a glossary entry>          a proposal for an existing entry (term, language of the term, target language, current candidates)
//   /t/new?asks_stance=1&propose_term=1&from=<term language>&to=<target language>   a new term (the values of the page's filter; left out when absent)
// The template is built by the server from checked values only (the term and languages read from the entry by its id, language tags that passed the check). There is no path that
// puts a string of the URL into the title or the body as it is (?title=, ?body=), so that a crafted link cannot put text into someone else's post screen. The member can rewrite the title
// and the body freely, like any topic (the template helps with the first draft and is not checked).
// It does not read stances: whether a proposal is adopted is decided by the person in charge, who names the proposal post when changing the glossary (glossary.server.ts).

export type ProposalPrefill = { title: string; body: string };

// The longest term shown in the title (the title of a topic is at most 200 characters; the rest of the sentence needs about 40). The body keeps the whole term.
export const TITLE_TERM_MAX = 100;

// A term or candidate is one line (the glossary refuses anything else), but rows that were written before that rule may still contain control characters:
// they must not start a new line in the template, which would let a term inject Markdown blocks into the body of another member's proposal.
export function oneLine(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim();
}

// The term as it appears in the title: one line, cut at TITLE_TERM_MAX characters (counted in code points) with an ellipsis.
export function titleTerm(term: string): string {
  const chars = [...oneLine(term)];
  return chars.length > TITLE_TERM_MAX ? `${chars.slice(0, TITLE_TERM_MAX).join("")}…` : chars.join("");
}

// The term and the translation go into inline code (backticks): a translation keeps code as it is, so even when the proposal is translated into another language
// the term and the translation stay readable as written. A term that contains backticks gets a longer fence.
export function inlineCode(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad = /^[` ]|[` ]$/.test(text) ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

// The tag is added to the language name so that the person in charge does not mistake which entry is meant. The name is written in the language of the template.
function langLabel(lang: Lang, locale: Lang): string {
  const wide = locale === "ja" || locale === "zh-Hans" || locale === "zh-Hant";
  return wide ? `${languageName(lang, locale)}（${lang}）` : `${languageName(lang, locale)} (${lang})`;
}

// Null without propose_term=1 (the ordinary new-topic screen). If entry is an active entry, its values go in. Otherwise from and to go in (valid enabled languages that differ from each other).
// With neither, the template is blank. The text is made from the messages of `locale` (the default language of the member's posts, not the language of the screen).
export async function glossaryProposalPrefill(
  db: Db,
  params: URLSearchParams,
  opts: { locale: Lang; enabled: readonly Lang[] },
): Promise<ProposalPrefill | null> {
  if (params.get("propose_term") !== "1") return null;
  const { locale } = opts;
  const o = { locale };
  const entryId = parseIdOrNull(params.get("entry") ?? undefined);
  const entry = entryId === null ? null : await getActiveGlossaryEntry(db, entryId);
  let term: string | null = null;
  let from: Lang | null = null;
  let to: Lang | null = null;
  let current: string[] = [];
  if (entry) {
    term = oneLine(entry.term);
    from = entry.lang;
    to = entry.targetLang;
    current = entry.candidates.map(oneLine).filter((c) => c !== "");
  } else {
    const wanted = (name: string): Lang | null => {
      const value = params.get(name);
      return isLang(value) && opts.enabled.includes(value) ? value : null;
    };
    const f = wanted("from");
    const t = wanted("to");
    // A request that names the same language as both the term language and the target language puts neither in.
    if (f === null || t === null || f !== t) {
      from = f;
      to = t;
    }
  }
  const target = to ? languageName(to, locale) : null;
  const title = term !== null && target !== null ? m.proposal_title_entry({ term: titleTerm(term), target }, o) : to !== null ? m.proposal_title_new({ target: target ?? "" }, o) : m.proposal_title_blank({}, o);
  const separator = locale === "ja" || locale === "zh-Hans" || locale === "zh-Hant" ? "、" : ", ";
  const lines = [
    m.proposal_body_term({ term: term === null || term === "" ? "` `" : inlineCode(term) }, o),
    m.proposal_body_term_lang({ lang: from ? langLabel(from, locale) : "" }, o),
    m.proposal_body_target_lang({ lang: to ? langLabel(to, locale) : "" }, o),
    ...(entry ? [m.proposal_body_current({ candidates: current.length > 0 ? current.map(inlineCode).join(separator) : m.proposal_body_current_none({}, o) }, o)] : []),
    m.proposal_body_proposed({}, o),
    m.proposal_body_reason({}, o),
  ];
  return { title, body: `${lines.join("\n")}\n` };
}
