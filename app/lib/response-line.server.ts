import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "./db/client.server";
import { entries, translations } from "./db/schema";
import { pickTranslation, SHOWN_KINDS } from "./display";
import { isLang, type Lang, type SourceLang } from "./languages";
import { loadResponsePostTargets, parseResponsePost, responsePostLine } from "./response-post.server";

type Source = { id: number; lang: string; body: string };
const key = (id: number, lang: string) => `${id}:${lang}`;
export const joinResponsePostLine = (line: string, body: string) => body ? `${line}\n\n${body}` : line;

// Resolve public targets before reading any title translations. Batching keeps
// a list or an all-language Markdown export independent of its response count.
async function loadLines(db: Db, sources: readonly Source[], langs: readonly Lang[]) {
  const responses = sources.flatMap(source => {
    const parsed = isLang(source.lang) ? parseResponsePost(source.body) : null;
    return parsed ? [{ ...parsed, id: source.id }] : [];
  });
  const lines = new Map<string, { topicId: number; line: string; body: string; readable: boolean }>();
  if (!responses.length) return lines;
  const targets = await loadResponsePostTargets(db, responses.map(r => r.topicId));
  const titled = targets.filter(t => t.title !== null).map(t => t.id);
  const titles = titled.length ? await db.select({ entryId: translations.entryId, lang: translations.lang, text: translations.text,
    kind: translations.kind, sourceHash: translations.sourceHash, mentionRevision: translations.mentionRevision, flags: translations.flags })
    .from(translations).where(and(inArray(translations.entryId, titled),
    eq(translations.field, "title"), inArray(translations.lang, [...langs]), inArray(translations.kind, [...SHOWN_KINDS]))) : [];
  const titlesByTarget = new Map<string, typeof titles>();
  for (const title of titles) {
    const k = key(title.entryId, title.lang);
    const group = titlesByTarget.get(k) ?? [];
    group.push(title);
    titlesByTarget.set(k, group);
  }
  const targetOf = new Map(targets.map(t => [t.id, t]));
  for (const response of responses) for (const lang of langs) {
    const target = targetOf.get(response.topicId);
    const title = target && target.title !== null && target.lang !== lang
      ? pickTranslation(titlesByTarget.get(key(target.id, lang)) ?? [], target.sourceHash, target.mentionRevision)?.text ?? target.title
      : target?.title ?? null;
    lines.set(key(response.id, lang), { topicId: response.topicId, line: target ? responsePostLine(target.id, title, target.handle, lang) : response.line,
      body: response.body, readable: !!target });
  }
  return lines;
}

// Jobs translate only the remaining body, then store a complete translation.
// An unreadable target stays ordinary source text; no extra information is read.
export async function prepareResponsePostTranslation(db: Db, body: string, from: SourceLang, to: Lang) {
  const line = (await loadLines(db, [{ id: 0, lang: from, body }], [to])).get(key(0, to));
  // An opening with nothing after it goes through ordinary translation (an empty request
  // would fail or be flagged); reading still replaces the opening.
  return line?.readable && line.body.trim() ? line : null;
}

type BodyRow = { entryId: number; field: string; kind: string; lang: string; text: string };

// Project current labels at every reading boundary, leaving stored translations,
// revisions and quality flags intact. Human-edited openings are kept. A changed projection
// cannot use HTML cached for the stored text (nor pass its guarded cache save).
export async function localizeResponseBodies<T extends BodyRow>(db: Db, rows: readonly T[], loadedSources?: readonly Source[]): Promise<T[]> {
  const machine = (row: BodyRow) => row.kind === "primary" || row.kind === "secondary";
  const eligible = (row: BodyRow) => isLang(row.lang) && (machine(row) || row.kind === "human" && parseResponsePost(row.text, row.lang) !== null);
  const bodies = rows.filter(r => r.field === "body" && eligible(r));
  if (!bodies.length) return [...rows];
  const sources = loadedSources ?? await db.select({ id: entries.id, lang: entries.lang, body: entries.body }).from(entries)
    .where(and(inArray(entries.id, [...new Set(bodies.map(r => r.entryId))]), eq(entries.kind, "topic")));
  const lines = await loadLines(db, sources, [...new Set(bodies.map(r => r.lang as Lang))]);
  return rows.map(row => {
    if (row.field !== "body" || !eligible(row)) return row;
    const response = lines.get(key(row.entryId, row.lang));
    if (!response) return row;
    if (row.kind === "human" && (!isLang(row.lang) || parseResponsePost(row.text, row.lang)?.topicId !== response.topicId)) return row;
    // The generated paragraph occupies the same position in saved translations.
    const rest = row.text.replace(/^[\s\S]*?(?:\r?\n[\t ]*\r?\n|$)/, "");
    const text = joinResponsePostLine(response.line, rest);
    return text === row.text ? row : { ...row, text, html: null, cardHtml: null, htmlVersion: 0 };
  });
}
