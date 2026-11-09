import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "./db/client.server";
import { entries, translations } from "./db/schema";
import { isStale, isUsablePrimary, pickTranslation, SHOWN_KINDS } from "./display";
import { isLang, type Lang } from "./languages";
import { publicTopicPlace } from "./visibility.server";
import { parseResponsePost } from "./response-post.server";
import { authorTermDeclarations, terminologyPassages, type TranslationTerms } from "./translation-terms";

type TermSource = { kind: string; lang: string; body: string };

// Stored translations retain the opening paragraph at the same position, even
// when older machine wording cannot itself be parsed in the target language.
export function postTerminologyBodies(entry: TermSource, translation?: { text: string; kind: string; lang: string }) {
  const response = entry.kind === "topic" ? parseResponsePost(entry.body) : null;
  const stripOpening = response && translation && (translation.kind !== "human" || isLang(translation.lang) && parseResponsePost(translation.text, translation.lang)?.topicId === response.topicId);
  return {
    body: response?.body ?? entry.body,
    translation: stripOpening ? translation.text.replace(/^[\s\S]*?(?:\r?\n[\t ]*\r?\n|$)/, "") : translation?.text,
  };
}

// The shared parser identifies the target; visibility is checked here before
// reading its translations. No reference-index row or notification is needed.
export async function translationTermsFor(db: Db, entry: TermSource & { id: number }, to: Lang): Promise<TranslationTerms | undefined> {
  const { body: sourceBody } = postTerminologyBodies(entry);
  const author = authorTermDeclarations(sourceBody, to);
  const terms: TranslationTerms = { author };
  if (entry.kind === "topic") {
    const target = parseResponsePost(entry.body)?.topicId ?? null;
    if (target !== null && target !== entry.id) {
      const [original] = await db.select({ id: entries.id, kind: entries.kind, title: entries.title, body: entries.body, lang: entries.lang, sourceHash: entries.sourceHash, mentionRevision: entries.mentionRevision }).from(entries)
        .where(and(eq(entries.id, target), eq(entries.kind, "topic"), isNull(entries.hiddenAt), isNull(entries.deletedAt), publicTopicPlace()));
      if (original) {
        const rows = await db.select().from(translations).where(and(eq(translations.entryId, original.id), eq(translations.lang, to), inArray(translations.kind, [...SHOWN_KINDS])));
        const current = (field: string) => {
          const row = pickTranslation(rows.filter(r => r.field === field), original.sourceHash, original.mentionRevision);
          return row && !isStale(row.flags) && isUsablePrimary(row, original.sourceHash, original.mentionRevision) ? row : undefined;
        };
        const title = original.lang === to ? original.title ?? undefined : current("title")?.text;
        const originalBodies = postTerminologyBodies(original, current("body"));
        const body = original.lang === to ? originalBodies.body : originalBodies.translation;
        const declarations = authorTermDeclarations(originalBodies.body, to);
        terms.response = {
          ...(original.title && title ? { title: { source: original.title.slice(0, 300), translation: title.slice(0, 300) } } : {}),
          passages: body ? terminologyPassages(originalBodies.body, body, sourceBody) : [], author: declarations,
        };
        if (!terms.response.title && !terms.response.passages.length && !declarations.length) delete terms.response;
      }
    }
  }
  return author.length || terms.response ? terms : undefined;
}
