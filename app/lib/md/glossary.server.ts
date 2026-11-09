import type { Db } from "~/lib/db/client.server";
import type { GlossaryContent } from "~/lib/glossary";
import { loadGlossaryPage, type GlossaryQuery } from "~/lib/glossary-page.server";
import { joinBlocks, mdBlock, yamlList, type FmValue } from "~/lib/md/frontmatter.server";
import { isoSeconds, mdUrl, siteUrl, threadCanonical, twinPreamble } from "~/lib/md/urls.server";
import type { Viewer } from "~/lib/roles.server";
import { getGlossaryVersion } from "~/lib/translations.server";

// Glossary Markdown twin (/glossary.md/.txt). Frontmatter type:glossary with version/filters; body YAML array
// containing id, term/source/target languages, suggestions, note, two flags, last editor/time and history; end with paging block.
// Same content as /glossary, including editor handles/history. Same parameters, but no default filter based on the reader's display language,
// so a URL returns identical content to everyone. Terms, notes and handles are human input and use the YAML serializer under frontmatter rules.
// Excluded from /changes.md and manifest: a list page rather than posts; glossary_version identifies changes.

export type GlossaryMdOptions = GlossaryQuery & { k: string | null };

const contentValue = (c: GlossaryContent | null): FmValue | undefined =>
  c === null ? undefined : { term: c.term, candidates: c.candidates, note: c.note, keep_original: c.keepOriginal, needs_review: c.needsReview };

export async function buildGlossaryMarkdown(db: Db, viewer: Viewer | null, opts: GlossaryMdOptions): Promise<string> {
  const { items, hasNext } = await loadGlossaryPage(db, viewer, opts);
  const filters: Record<string, string> = {};
  if (opts.to) filters.to = opts.to;
  if (opts.from) filters.from = opts.from;
  if (opts.deleted) filters.deleted = "1";
  const query = (page: number) => {
    const params = new URLSearchParams(filters);
    if (page > 1) params.set("page", String(page));
    const text = params.toString();
    return text ? `?${text}` : "";
  };
  const list = items.map((e): { [key: string]: FmValue | undefined } => ({
    id: `g-${e.id}`,
    term: e.term,
    lang: e.lang,
    target_lang: e.targetLang,
    candidates: e.candidates,
    note: e.note,
    keep_original: e.keepOriginal,
    needs_review: e.needsReview,
    // Only deleted entries.
    deleted: e.deleted ? true : undefined,
    last_edited_by: e.lastBy ?? undefined,
    last_edited_at: isoSeconds(e.lastAt),
    history: e.history.map(
      (h): { [key: string]: FmValue | undefined } => ({
        at: isoSeconds(h.at),
        by: h.by ?? undefined,
        change: h.kind,
        before: contentValue(h.before),
        after: contentValue(h.after),
        proposal: h.proposalId === null ? undefined : threadCanonical(h.proposalId),
        proposal_md: h.proposalId === null ? undefined : mdUrl(`/t/${h.proposalId}.md`, { k: opts.k, lang: null }),
      }),
    ),
  }));
  const header = mdBlock(
    {
      type: "glossary",
      title: "Glossary: recommended translations",
      canonical: siteUrl(`/glossary${query(opts.page)}`),
      from: opts.from ?? undefined,
      to: opts.to ?? undefined,
      deleted: opts.deleted ? true : undefined,
      glossary_version: (await getGlossaryVersion(db)) ?? undefined,
      content_trust: "untrusted_user_content",
    },
    null,
    { preamble: twinPreamble() },
  );
  const body = list.length === 0 ? "No entries.\n" : yamlList(list);
  const next = hasNext ? mdUrl("/glossary.md", { k: opts.k, lang: null, page: opts.page + 1, extra: filters }) : null;
  const footer = mdBlock({ type: "index", page: opts.page, next, content_trust: "untrusted_user_content" }, next ? `Next page: ${next}` : "End of list.");
  return joinBlocks([header, body, footer]);
}
