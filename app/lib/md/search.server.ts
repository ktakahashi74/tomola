import { loadDisplayNames, displayNameFields } from "../display-names.server";
import { authorLabel } from "../deleted-member";
import type { Db } from "~/lib/db/client.server";
import { replyPagesOf } from "~/lib/reply-pages.server";
import { literalExcerpt, type CombinedFound } from "~/lib/combined-search.server";
import { joinBlocks, mdBlock, yamlList, type FmValue } from "~/lib/md/frontmatter.server";
import { TRANSLATION_STATUS } from "~/lib/md/translations.server";
import { mdUrl, siteUrl, threadCanonical, twinPreamble, replyCanonical } from "~/lib/md/urls.server";
import type { Lang } from "~/lib/languages";
import { plainExcerpt } from "~/lib/plain-text.server";
import { toHits } from "~/lib/search.server";

// Search twins opt into literal-first results and degradation status. MCP keeps the semantic-only shape.
// Each YAML item includes the original title/body excerpt, selected translations and credential-free links;
// combined results also identify the match field, source language and matching excerpt.
// Callers filter unreadable posts before passing results to this builder.

// Excerpts are plain text (Markdown and math markup removed), cut to this many characters.
const EXCERPT_CHARS = 300;

export type SearchMdOptions = { lang: Lang | null; k: string | null; search?: { literalOnly: boolean } };

export async function buildSearchMarkdown(db: Db, query: string, found: readonly CombinedFound[], opts: SearchMdOptions): Promise<string> {
  const names = await loadDisplayNames(db, found.map(f => f.authorHandle));
  const hits = opts.lang ? await toHits(db, found, { readLangs: [], displayLang: opts.lang }) : [];
  const hitOf = new Map(hits.map((h) => [h.id, h]));
  const pages = await replyPagesOf(db, found.filter(row => row.kind === "reply"));
  const translation = (t: NonNullable<(typeof hits)[number]["title"]["translation"]>, text: string): FmValue => ({
    lang: opts.lang as Lang,
    status: TRANSLATION_STATUS[t.kind],
    engine: t.engine,
    model: t.model,
    fallback: t.fallback ? true : undefined,
    stale: t.stale,
    text,
  });
  const items = await Promise.all(
    found.map(async (f): Promise<{ [key: string]: FmValue | undefined }> => {
      const isTopic = f.kind === "topic";
      const hit = hitOf.get(f.id);
      const page = isTopic ? 1 : pages.get(f.id) ?? 1;
      return {
        id: `${isTopic ? "p" : "c"}-${f.id}`,
        type: isTopic ? "post" : "comment",
        thread: `p-${f.threadId}`,
        // A topic without a title has no title key (and no thread_title for its replies): a reader takes a missing key as "no title".
        [isTopic ? "title" : "thread_title"]: f.topicTitle ?? undefined,
        lang: f.lang,
        ...(f.langCode ? { lang_code: f.langCode } : {}),
        author: authorLabel(f.authorHandle),
        ...displayNameFields(names.get(f.authorHandle ?? "")),
        distance: f.match ? undefined : Math.round(f.distance * 10_000) / 10_000,
        ...(opts.search ? {
          match_kind: f.match ? "literal" : "semantic",
          match: f.match ? { field: f.match.field, source: f.match.source, lang: f.match.lang, excerpt: await literalExcerpt(f.match, query) } : undefined,
        } : {}),
        excerpt: (await plainExcerpt(f.body, EXCERPT_CHARS)),
        md: mdUrl(`/t/${f.threadId}.md`, { k: opts.k, lang: opts.lang, page }),
        canonical: isTopic ? threadCanonical(f.threadId) : replyCanonical(f.threadId, f.id, page),
        title_translation: hit?.title.translation && !hit.title.fromBody ? translation(hit.title.translation, hit.title.text) : undefined,
        excerpt_translation: hit?.excerpt.translation ? translation(hit.excerpt.translation, hit.excerpt.text) : undefined,
      };
    }),
  );
  const header = mdBlock(
    {
      type: "index",
      title: "Search results",
      query,
      lang: opts.lang ?? undefined,
      ...(opts.search ? { search_status: opts.search.literalOnly ? "literal_only" : "combined" } : {}),
      canonical: `${siteUrl("/search")}?q=${encodeURIComponent(query)}`,
      content_trust: "untrusted_user_content",
    },
    null,
    { preamble: twinPreamble() },
  );
  const notice = opts.search?.literalOnly ? "# Semantic search is currently unavailable. Only literal matches are shown.\n\n" : "";
  const body = notice + (items.length === 0 ? "No posts found.\n" : yamlList(items));
  const order = opts.search ? "End of results (literal matches first, then closest in meaning)." : "End of results (closest first).";
  const footer = mdBlock({ type: "index", count: items.length, content_trust: "untrusted_user_content" }, order);
  return joinBlocks([header, body, footer]);
}
