import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { entries, profiles } from "~/lib/db/schema";
import { LANGS, type Lang } from "~/lib/languages";
import { parseIdOrNull } from "~/lib/params.server";
import { publicTopicPlace } from "~/lib/visibility.server";
import { villageSlug } from "~/lib/villages.server";
import { m } from "~/paraglide/messages.js";
import { DELETED_MEMBER_HANDLE, DELETED_MEMBER_ID } from "~/lib/deleted-member";
import { sharePrefill } from "~/lib/share-prefill";

// Keep source text inside one Markdown link, including the author: link labels
// do not create mentions. Escape formatting so a title cannot break that link.
const labelText = (text: string) => text.replace(/[\\`*_\[\]<&$~^]/g, "\\$&").replace(/[\r\n\u2028\u2029]/g, " ");

export function responsePostId(params: URLSearchParams): number | null {
  return params.has("alt_of") || params.has("propose_term") || sharePrefill(params) ? null : parseResponseId(params.get("respond"));
}

const parseResponseId = (value: string | null) => parseIdOrNull(value?.replace(/^0+(?=\d)/, ""));

// Only browser writing surfaces supply this context. API/MCP draft schemas do
// not accept it, and never infer it from a link in the body.
export const responseIdFromForm = (form: FormData) => parseIdOrNull(String(form.get("responseTo") ?? ""));

export function responsePostLine(id: number, title: string | null, handle: string | null, locale: Lang): string {
  const inputs = { handle: labelText(handle ?? "?"), url: `/t/${id}` };
  if (handle === null) return title === null
    ? m.response_post_departed_untitled(inputs, { locale })
    : m.response_post_departed_prefill({ ...inputs, title: labelText(title) }, { locale });
  return title === null
    ? m.response_post_untitled(inputs, { locale })
    : m.response_post_prefill({ ...inputs, title: labelText(title) }, { locale });
}

const regexText = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const openingPatterns = new Map<Lang, RegExp[]>();

// Recognize only a complete, single-line opening paragraph. The interface
// language can differ from the detected post language. An explicit language
// restricts the wording. Labels are opaque: title edits and Markdown escaping
// must not change the target. This is a syntactic match, not a visibility check.
export function parseResponsePost(body: string, sourceLang?: Lang): { topicId: number; line: string; body: string } | null {
  if (sourceLang === undefined) {
    for (const lang of LANGS) {
      const parsed = parseResponsePost(body, lang);
      if (parsed) return parsed;
    }
    return null;
  }
  const first = /^([^\r\n]+)(?:\r?\n[\t ]*\r?\n|$)/.exec(body);
  if (!first) return null;
  let patterns = openingPatterns.get(sourceLang);
  if (!patterns) {
    const inputs = { title: "TITLE", handle: "HANDLE", url: "URL" };
    patterns = [m.response_post_prefill(inputs, { locale: sourceLang }), m.response_post_untitled(inputs, { locale: sourceLang }),
      m.response_post_departed_prefill(inputs, { locale: sourceLang }), m.response_post_departed_untitled(inputs, { locale: sourceLang })].flatMap(template => {
      const start = template.indexOf("[");
      const end = template.indexOf("](URL)");
      if (start < 0 || end < start) return [];
      return [new RegExp(`^${regexText(template.slice(0, start))}\\[(?:\\\\.|[^\\[\\]\\\\\\r\\n])*\\]\\(/t/([1-9]\\d{0,15})\\)${regexText(template.slice(end + "](URL)".length))}$`)];
    });
    openingPatterns.set(sourceLang, patterns);
  }
  for (const pattern of patterns) {
    const id = parseIdOrNull(pattern.exec(first[1])?.[1]);
    if (id !== null) return { topicId: id, line: first[1], body: body.slice(first[0].length) };
  }
  return null;
}

// Both compose prefills and localized reading resolve exactly the same public
// targets and departed-author labels, including targets without a profile.
export async function loadResponsePostTargets(db: Db, ids: readonly number[]) {
  if (!ids.length) return [];
  const targets = await db.select({ id: entries.id, authorId: entries.authorId, title: entries.title, villageId: entries.villageId,
    lang: entries.lang, sourceHash: entries.sourceHash, mentionRevision: entries.mentionRevision, handle: profiles.handle }).from(entries)
    .leftJoin(profiles, eq(profiles.userId, entries.authorId))
    .where(and(inArray(entries.id, [...new Set(ids)]), eq(entries.kind, "topic"), isNull(entries.deletedAt), isNull(entries.hiddenAt), publicTopicPlace()));
  return targets.map(target => ({ ...target, handle: target.authorId === DELETED_MEMBER_ID || target.handle === DELETED_MEMBER_HANDLE ? null : target.handle }));
}

export async function responsePostPrefill(db: Db, rawId: string | null, locale: Lang) {
  const id = parseResponseId(rawId);
  if (id === null) return null;
  const [topic] = await loadResponsePostTargets(db, [id]);
  if (!topic) return null;
  const line = responsePostLine(id, topic.title, topic.handle, locale);
  return { prefill: { title: "", body: `${line}\n\n` }, village: await villageSlug(db, topic.villageId) };
}
