import type { Db } from "~/lib/db/client.server";
import type { GlossaryChangeKind, GlossaryContent } from "~/lib/glossary";
import { canEditGlossary, countGlossaryRevisions, editorLabel, listGlossary, listGlossaryRevisions } from "~/lib/glossary.server";
import { isLang, LANGS, type Lang } from "~/lib/languages";
import { parsePageParam } from "~/lib/pagination";
import type { Viewer } from "~/lib/roles.server";

// Shared listing/history reads for member /glossary and /glossary.md.
// Expose editors only as strings passed through editorLabel. Never pass raw handles to the UI or Markdown, keeping visibility changes centralized.

// How to appeal adoption/rejection: the principles/appeals page. Enable after /principles is added. Until its destination exists, show text without a link.
// tests/glossary-page.test.ts detects app/routes/principles.tsx existing while this stays false, preventing forgotten link activation when the page becomes available.
// The page is implemented by app/routes/principles.tsx; the "How to object" section has the id objections, so the link is shown.
export const PRINCIPLES_PAGE_READY = true;
export const OBJECTION_PATH = "/principles#objections";

export type GlossaryQuery = { from: Lang | null; to: Lang | null; deleted: boolean; page: number };

// Parse screen query parameters. Disabled languages fall back to defaults. Invalid page returns null for 404.
// enabled: languages enabled at this site (ENABLED_LANGS). Use ?from=/?to= only for enabled languages; otherwise default from to 「すべて」 and to to defaults.to.
// If defaults.to is disabled, to is null.
export function parseGlossaryQuery(params: URLSearchParams, defaults: { to: Lang | null }, enabled: readonly Lang[] = LANGS): GlossaryQuery | null {
  const page = parsePageParam(params.get("page"));
  if (page === null) return null;
  const from = params.get("from");
  const to = params.get("to");
  const ok = (value: unknown): value is Lang => isLang(value) && enabled.includes(value);
  return { from: ok(from) ? from : null, to: ok(to) ? to : ok(defaults.to) ? defaults.to : null, deleted: params.get("deleted") === "1", page };
}

export type GlossaryHistoryItem = {
  id: number;
  kind: GlossaryChangeKind;
  at: Date;
  // Editor (@handle), or null if unrecorded.
  by: string | null;
  before: GlossaryContent | null;
  after: GlossaryContent | null;
  // Proposal entry number (topic).
  proposalId: number | null;
};

export type GlossaryPageItem = {
  id: number;
  term: string;
  lang: Lang;
  targetLang: Lang;
  candidates: string[];
  note: string;
  keepOriginal: boolean;
  needsReview: boolean;
  deleted: boolean;
  // Last editor and time; for deleted entries, the person who deleted them.
  lastBy: string | null;
  lastAt: Date;
  // Newest first. historyLimit caps results from the newest end; historyTotal counts all history.
  history: GlossaryHistoryItem[];
  historyTotal: number;
  // Whether the viewer may edit this entry: operators and assigned target-language moderators.
  canEdit: boolean;
};

export async function loadGlossaryPage(
  db: Db,
  viewer: Viewer | null,
  query: GlossaryQuery,
  opts: { historyLimit?: number } = {},
): Promise<{ items: GlossaryPageItem[]; hasNext: boolean }> {
  const { entries, hasNext } = await listGlossary(db, { from: query.from ?? undefined, to: query.to ?? undefined, deleted: query.deleted, page: query.page });
  const ids = entries.map((e) => e.id);
  const [histories, totals] = await Promise.all([listGlossaryRevisions(db, ids, { limit: opts.historyLimit }), countGlossaryRevisions(db, ids)]);
  return {
    hasNext,
    items: entries.map((e) => ({
      id: e.id,
      term: e.term,
      lang: e.lang,
      targetLang: e.targetLang,
      candidates: e.candidates,
      note: e.note,
      keepOriginal: e.keepOriginal,
      needsReview: e.needsReview,
      deleted: e.deletedAt !== null,
      lastBy: editorLabel(viewer, { editorHandle: e.updatedByHandle }),
      lastAt: e.deletedAt ?? e.updatedAt,
      historyTotal: totals.get(e.id) ?? 0,
      history: (histories.get(e.id) ?? []).map((r) => ({
        id: r.id,
        kind: r.kind,
        at: r.createdAt,
        by: editorLabel(viewer, r),
        before: r.before,
        after: r.after,
        proposalId: r.proposalEntryId,
      })),
      canEdit: viewer !== null && canEditGlossary(viewer.scope, e.targetLang),
    })),
  };
}
