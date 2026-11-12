import { prepareEntryFigureDisplay } from "./figure-display.server";
import { safeErrorText } from "~/lib/error-text.server";
import { withMarkdownRead } from "./markdown-budget.server";
import { and, eq, getTableColumns, inArray, isNotNull, or } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { entries, translations } from "~/lib/db/schema";
import { decideShown, isStale, pickOlderTranslation, pickTranslation, SHOWN_KINDS, wantsTranslation, type ShownKind, type Shown } from "~/lib/display";
import { renderTranslationHtml } from "~/lib/entries.server";
import { headlineFromBody } from "~/lib/headline.server";
import type { Lang, SourceLang } from "~/lib/languages";
import { RENDER_VERSION, type RenderedEntry } from "~/lib/markdown.server";
import type { MentionTargets } from "~/lib/mentions-md.server";
import { resolveSourceSnapshotsFor, resolveTranslationMentionsFor, type SourceMentionSnapshot } from "~/lib/mentions.server";
import { saveRenderedTranslation } from "~/lib/render-cache.server";
import { loadReportNotices, reportNoticeKey, type ReportNotice } from "~/lib/translation-reports.server";
import { typesetText } from "~/lib/typeset-text";
import { availabilityKey, loadTranslationAvailability } from "~/lib/translation-availability.server";
import { FLAG_STRUCTURE_MISMATCH } from "~/lib/llm/flags";
import { localizeResponseBodies } from "./response-line.server";

// Decide display per entry by applying app/lib/display.ts rules to DB translation rows. Loaders return both versions; the screen holds both HTML bodies
// for client-side source/translation toggling.

export type TranslationTitle = { text: string; kind: ShownKind; stale: boolean };
// Human translation based on an older source revision, selectable when current-source primary is the default.
export type OlderView = {
  unseenIds?: number[];
  kind: "human";
  engine: string | null;
  model: string | null;
  // Loaded only when this version is selected by ?old=.
  html: string | null;
  // Older revision's translated title; fall back to the default translated title, then null.
  title: TranslationTitle | null;
  // The one line at the start of the translation of the body of the older version (topics only; it heads a topic without a title).
  headline: string | null;
};
export type TranslationView = {
  unseenIds?: number[];
  lang: Lang;
  // Body translation kind (human > primary), determining the label.
  kind: ShownKind;
  engine: string | null;
  model: string | null;
  // Machine translation by the secondary engine because the primary refused/failed (translations.fallback).
  fallback: boolean;
  // Human translation after the source was edited.
  stale: boolean;
  structureMismatch?: boolean;
  // The HTML of the translation of the body. With variant "card" (a list card): the card version (the beginning of a long body), and `truncated` is true when it was cut.
  html: string;
  truncated?: boolean;
  // Translated title, for topics only. Null if absent; show the source title.
  title: TranslationTitle | null;
  // The one line at the start of the translation of the body (topics only). It heads a topic without a title and gives its browser title (switching between the original and the translation changes the heading to the beginning of that version).
  headline: string | null;
  // Selectable human translation based on an older source revision. Null if absent.
  older: OlderView | null;
  // Mistranslation-report notices: open means unresolved reports on this translation (「この訳には指摘があります。原文も確かめてください」). retried means retranslation with a higher model after a report
  // (「指摘を受けて訳し直しました」), only if this translation is that retried machine translation. Null if neither.
  reportNotice: ReportNotice | null;
};
export type EntryDisplay = {
  needsCurrent?: boolean;
  // Default displayed revision after applying ?orig=<id>, ?tr=<id>, and ?old=<id> overrides.
  shown: Shown;
  // A translation is preferred but unavailable yet.
  pending: boolean;
  unavailable?: boolean;
  // A body translation exists, enabling toggling.
  translation: TranslationView | null;
};

export type DisplayInput = { id: number; kind: "topic" | "reply"; lang: SourceLang; sourceHash: string | null };
export type DisplayOptions = {
  // Topic HTML only: browser translation work and first-display reports.
  browser?: ReadonlySet<number>;
  readLangs: readonly Lang[];
  displayLang: Lang;
  // "full" (the thread page, the default) or "card" (a card of a list): the card uses the card version of the HTML of a translation (translations.card_html ?? translations.html)
  // and does not read the older translation (a card has no choice of versions).
  variant?: "full" | "card";
  forceOriginal?: ReadonlySet<number>;
  forceTranslation?: ReadonlySet<number>;
  forceOlder?: ReadonlySet<number>;
};

type Row = typeof translations.$inferSelect;
type Picked = Row & { kind: ShownKind };
type PickedOlder = Row & { kind: "human" };
export type PickedTranslations = {
  title: Picked | null;
  body: Picked | null;
  // Human translation based on an older source revision, not shown by default.
  titleOlder: PickedOlder | null;
  bodyOlder: PickedOlder | null;
};

type Field = "title" | "body";

// Read display-language translations and select per entry/field. Skip entries whose source language matches display language, since no translation is needed.
// fields: the fields to read (one array for all entries, or a function that decides per entry). The rows of title translations are not read for a topic without a title (entries.title is null):
// after an edit that takes the title off, an old title translation (a human fix included) may stay in the table, but neither the screen nor the Markdown twin uses it (the row is not deleted; it stays as the record of that version of the translation).
export async function loadPickedTranslations(
  db: Db,
  inputs: readonly DisplayInput[],
  displayLang: Lang,
  fields: readonly Field[] | ((entry: DisplayInput) => readonly Field[]) = ["title", "body"],
): Promise<Map<number, PickedTranslations>> {
  const wanted = inputs.filter((e) => e.lang !== displayLang);
  const out = new Map<number, PickedTranslations>();
  if (wanted.length === 0) return out;
  // Group the entries by the fields to read, so that one query reads the titles of some entries and the bodies of others.
  const groups = new Map<string, { fields: Field[]; ids: number[] }>();
  for (const entry of wanted) {
    const f = [...(typeof fields === "function" ? fields(entry) : fields)];
    if (f.length === 0) continue;
    const group = groups.get(f.join()) ?? { fields: f, ids: [] };
    group.ids.push(entry.id);
    groups.set(f.join(), group);
  }
  const rows = await localizeResponseBodies(db,
    groups.size === 0
      ? []
      : (
          await db
            .select({ ...getTableColumns(translations), currentMentionRevision: entries.mentionRevision })
            .from(translations)
            .innerJoin(entries, eq(entries.id, translations.entryId))
            .where(
              and(
                eq(translations.lang, displayLang),
                inArray(translations.kind, [...SHOWN_KINDS]),
                or(
                  ...[...groups.values()].map((g) =>
                    and(
                      inArray(translations.entryId, g.ids),
                      inArray(translations.field, g.fields),
                      // A title translation counts only while the topic has a title.
                      g.fields.includes("title") && g.fields.includes("body")
                        ? or(eq(translations.field, "body"), isNotNull(entries.title))
                        : g.fields.includes("title")
                          ? isNotNull(entries.title)
                          : undefined,
                    ),
                  ),
                ),
              ),
            )
        ));
  for (const entry of wanted) {
    const mine = rows.filter((r) => r.entryId === entry.id);
    const titles = mine.filter((r) => r.field === "title");
    const bodies = mine.filter((r) => r.field === "body");
    const revision = mine[0]?.currentMentionRevision;
    out.set(entry.id, {
      title: pickTranslation(titles, entry.sourceHash, revision),
      body: pickTranslation(bodies, entry.sourceHash, revision),
      titleOlder: pickOlderTranslation(titles, entry.sourceHash, revision),
      bodyOlder: pickOlderTranslation(bodies, entry.sourceHash, revision),
    });
  }
  return out;
}

// The full and card HTML of a translation are cached together with RENDER_VERSION. The prefixes differ from the original (p-<id>-<lang>- / c-<id>-<lang>-).
// cardHtml is null when the body was not cut (always for a reply); cardTruncated is derived from it, never stored separately.
// mentions: the members that the source snapshot names; the guarded save refuses to cache a rendering of an overwritten snapshot.
async function translationRender(db: Db, row: Row, entry: DisplayInput, mentions: MentionTargets, source: SourceMentionSnapshot | undefined): Promise<RenderedEntry> {
  if (row.html !== null && row.htmlVersion === RENDER_VERSION) return { html: row.html, cardHtml: row.cardHtml, cardTruncated: row.cardHtml !== null };
  const rendered = (await withMarkdownRead(() => renderTranslationHtml(entry.kind, entry.id, row.lang, row.text, mentions, row.kind === "primary")));
  try {
    if (source) await saveRenderedTranslation(db, row.id, row.text, rendered, { ...source, translationSourceHash: row.sourceHash, translationMentionRevision: row.mentionRevision });
  } catch (error) {
    console.warn(`[translations] could not cache rendered html for translation ${row.id}:`, safeErrorText(error));
  }
  return rendered;
}

// Notice kind. retried applies only when the displayed translation is the retried machine translation; subsequent manual corrections are not that translation.
function reportNoticeOf(notice: ReportNotice | undefined, kind: ShownKind): ReportNotice | null {
  if (notice === "open") return "open";
  return notice === "retried" && kind === "primary" ? "retried" : null;
}

export async function loadEntryDisplays(db: Db, inputs: readonly DisplayInput[], opts: DisplayOptions): Promise<Map<number, EntryDisplay>> {
  const browser = (id: number) => opts.browser?.has(id) ?? false;
  const picked = await loadPickedTranslations(db, inputs, opts.displayLang);
  const availability = await loadTranslationAvailability(db, inputs.filter(e => {
    const body = picked.get(e.id)?.body;
    return (!body || (browser(e.id) && (body.sourceHash !== e.sourceHash || isStale(body.flags)))) && wantsTranslation(e.lang, opts.readLangs, opts.displayLang);
  }), [opts.displayLang], undefined, { currentOnly: !!opts.browser });
  const notices = await loadReportNotices(
    db,
    inputs.filter((e) => picked.get(e.id)?.body).map((e) => ({ entryId: e.id, lang: opts.displayLang, sourceHash: e.sourceHash })),
  );
  // The posts with a translation whose stored rendering is missing or old: their source bodies are read once, for the members their translations can emphasize.
  const includeOlder = (id: number) => opts.variant !== "card" && !!opts.forceOlder?.has(id) && !opts.forceOriginal?.has(id);
  const needsRender = (row: Row | null) => row !== null && (row.html === null || row.htmlVersion !== RENDER_VERSION);
  const sourceOf = await resolveSourceSnapshotsFor(
    db,
    inputs.filter((e) => needsRender(picked.get(e.id)?.body ?? null) || (includeOlder(e.id) && needsRender(picked.get(e.id)?.bodyOlder ?? null))).map((e) => e.id),
  );
  const renderRows = [...picked.values()].flatMap(rows => [rows.body, ...(rows.bodyOlder && includeOlder(rows.bodyOlder.entryId) ? [rows.bodyOlder] : [])]).filter((row): row is Picked => row !== null && needsRender(row));
  const savedMentions = await resolveTranslationMentionsFor(db, renderRows);
  const decorateFigures = await prepareEntryFigureDisplay(db, inputs.map(entry => entry.id), opts.displayLang);
  const out = new Map<number, EntryDisplay>();
  const card = opts.variant === "card";
  // Report displayed rows even after their first timestamp: the writer may have
  // seen them before another reader. Do not expose lifetime markers to the browser.
  for (const entry of inputs) {
    const rows = picked.get(entry.id);
    const source = sourceOf.get(entry.id);
    const wants = wantsTranslation(entry.lang, opts.readLangs, opts.displayLang);
    let translation: TranslationView | null = null;
    if (rows?.body) {
      const title = rows.title
        ? { text: rows.title.kind === "primary" ? typesetText(rows.title.text, opts.displayLang) : rows.title.text, kind: rows.title.kind, stale: isStale(rows.title.flags) }
        : null;
      let older: OlderView | null = null;
      if (rows.bodyOlder && !card) {
        const olderTitle = rows.titleOlder
          ? { text: rows.titleOlder.text, kind: rows.titleOlder.kind, stale: true }
          : title;
        older = {
          ...(browser(entry.id) ? { unseenIds: [rows.bodyOlder, rows.titleOlder ?? rows.title].filter((r): r is Picked => !!r).map(r => r.id) } : {}),
          kind: rows.bodyOlder.kind,
          engine: rows.bodyOlder.engine,
          model: rows.bodyOlder.model,
          html: includeOlder(entry.id) ? decorateFigures(entry.id, (await translationRender(db, rows.bodyOlder, entry, savedMentions.get(rows.bodyOlder.id) ?? new Map(), source)).html) : null,
          title: olderTitle,
          headline: includeOlder(entry.id) && entry.kind === "topic" ? (await headlineFromBody(rows.bodyOlder.text)) : null,
        };
      }
      const render = await translationRender(db, rows.body, entry, savedMentions.get(rows.body.id) ?? new Map(), source);
      translation = {
        ...(browser(entry.id) && !card ? { unseenIds: [rows.body, rows.title].filter((r): r is Picked => !!r).map(r => r.id) } : {}),
        lang: opts.displayLang,
        kind: rows.body.kind,
        engine: rows.body.engine,
        model: rows.body.model,
        fallback: rows.body.fallback,
        stale: isStale(rows.body.flags) || (title?.stale ?? false),
        structureMismatch: rows.body.flags.includes(FLAG_STRUCTURE_MISMATCH) || (rows.title?.flags.includes(FLAG_STRUCTURE_MISMATCH) ?? false),
        html: decorateFigures(entry.id, card ? (render.cardHtml ?? render.html) : render.html),
        truncated: card && render.cardTruncated,
        title,
        // A card has no heading made from the body, so it does not need the headline.
        headline: entry.kind === "topic" && !card ? (await headlineFromBody(rows.body.text)) : null,
        older,
        reportNotice: reportNoticeOf(notices.get(reportNoticeKey(entry.id, opts.displayLang)), rows.body.kind),
      };
    }
    const force: Shown | null = opts.forceOriginal?.has(entry.id)
      ? "original"
      : opts.forceOlder?.has(entry.id)
        ? "older"
        : opts.forceTranslation?.has(entry.id)
          ? "translation"
          : null;
    const current = rows?.body && rows.body.sourceHash === entry.sourceHash && !isStale(rows.body.flags);
    out.set(entry.id, {
      ...(browser(entry.id) && !card && wants && !current && force !== "original" && availability.get(availabilityKey(entry.id, opts.displayLang)) !== "unavailable" ? { needsCurrent: true } : {}),
      shown: decideShown({ wants, hasTranslation: translation !== null, hasOlder: translation?.older != null, force }),
      pending: wants && translation === null && availability.get(availabilityKey(entry.id, opts.displayLang)) !== "unavailable",
      ...(wants && translation === null && availability.get(availabilityKey(entry.id, opts.displayLang)) === "unavailable" ? { unavailable: true } : {}),
      translation,
    });
  }
  return out;
}

// How a topic is shown in a list (the one line that names it). For a topic with a title the rule for showing a translation is the same as for a post (the original if its language is one the reader reads,
// otherwise the translation of the title in the display language; if there is none, the original). The pending state reflects the availability of the body translation.
// A topic without a title (a short remark) gets the same rule applied to its body, and shows the beginning of the body (headlineFromBody; fromBody: true). text is an empty string for a body with no text (an image without alt text, for example).
export type TitleDisplay = {
  text: string;
  lang: SourceLang;
  // Translation kind when showing a translation; null for the source.
  kind: ShownKind | null;
  engine: string | null;
  fallback: boolean;
  stale: boolean;
  structureMismatch?: boolean;
  unavailable?: boolean;
  pending: boolean;
  // There is no title and the beginning of the body is shown (so that the screen and the Markdown twin can tell it from a title).
  fromBody: boolean;
};

export type LineTranslation = Pick<Row, "text" | "engine" | "model" | "fallback" | "flags"> & { kind: ShownKind };
type PickedLineTranslations = {
  title: LineTranslation | null;
  body: LineTranslation | null;
  hasBody: boolean;
};

// Lists need translated text only for titles and titleless headlines. Read body eligibility separately,
// without text or cached HTML, in one batch regardless of how many titled topics are on the page.
export async function loadTopicLineTranslations(
  db: Db,
  inputs: readonly (DisplayInput & { title: string | null })[],
  displayLang: Lang,
): Promise<Map<number, PickedLineTranslations>> {
  const wanted = inputs.filter(e => e.lang !== displayLang);
  const out = new Map<number, PickedLineTranslations>();
  if (wanted.length === 0) return out;
  const titled = wanted.filter(e => e.title !== null).map(e => e.id);
  const titleless = wanted.filter(e => e.title === null).map(e => e.id);
  const eligibility = {
    entryId: translations.entryId,
    kind: translations.kind,
    sourceHash: translations.sourceHash,
    mentionRevision: translations.mentionRevision,
    flags: translations.flags,
    currentMentionRevision: entries.mentionRevision,
  };
  const common = and(eq(translations.lang, displayLang), inArray(translations.kind, [...SHOWN_KINDS]));
  const textRows = await localizeResponseBodies(db, await db
    .select({ ...eligibility, lang: translations.lang, field: translations.field, text: translations.text, engine: translations.engine, model: translations.model, fallback: translations.fallback })
    .from(translations)
    .innerJoin(entries, eq(entries.id, translations.entryId))
    .where(and(common, or(
      titled.length ? and(inArray(translations.entryId, titled), eq(translations.field, "title"), isNotNull(entries.title)) : undefined,
      titleless.length ? and(inArray(translations.entryId, titleless), eq(translations.field, "body")) : undefined,
    ))));
  const bodyRows = titled.length ? await db
    .select(eligibility)
    .from(translations)
    .innerJoin(entries, eq(entries.id, translations.entryId))
    .where(and(common, inArray(translations.entryId, titled), eq(translations.field, "body"))) : [];
  for (const entry of wanted) {
    const mine = textRows.filter(r => r.entryId === entry.id);
    const bodies = entry.title === null ? mine : bodyRows.filter(r => r.entryId === entry.id);
    out.set(entry.id, {
      title: pickTranslation(mine.filter(r => r.field === "title"), entry.sourceHash, mine[0]?.currentMentionRevision),
      body: entry.title === null ? pickTranslation(mine, entry.sourceHash, mine[0]?.currentMentionRevision) : null,
      hasBody: pickTranslation(bodies, entry.sourceHash, bodies[0]?.currentMentionRevision) !== null,
    });
  }
  return out;
}

export type TopicLine = {
  text: string;
  lang: SourceLang;
  // The row of the translation (when a translation is shown; null for the original).
  row: LineTranslation | null;
  pending: boolean;
  fromBody: boolean;
};

// Decides the one line that names a topic (loadTitleDisplays and search share this rule). body: needed only for a topic without a title.
export async function topicLine(
  topic: { id: number; lang: SourceLang; title: string | null; body?: string },
  picked: PickedLineTranslations | undefined,
  wants: boolean,
  displayLang: Lang,
  typeset = false,
): Promise<TopicLine> {
  if (topic.title === null) {
    const row = picked?.body ?? null;
    if (wants && row) return { text: (await headlineFromBody(row.text)), lang: displayLang, row, pending: false, fromBody: true };
    return { text: (await headlineFromBody(topic.body ?? "")), lang: topic.lang, row: null, pending: wants, fromBody: true };
  }
  const row = picked?.title ?? null;
  if (wants && row) return { text: typeset && row.kind === "primary" ? typesetText(row.text, displayLang) : row.text, lang: displayLang, row, pending: !picked?.hasBody, fromBody: false };
  return { text: topic.title, lang: topic.lang, row: null, pending: wants && !picked?.hasBody, fromBody: false };
}

// The bodies of the topics without a title (the ones the caller gave, and the ones missing, which are read here in one query).
export async function loadTitlelessBodies(db: Db, topics: ReadonlyArray<{ id: number; title: string | null; body?: string }>): Promise<Map<number, string>> {
  const bodies = new Map<number, string>();
  const missing: number[] = [];
  for (const t of topics) {
    if (t.title !== null) continue;
    if (t.body !== undefined) bodies.set(t.id, t.body);
    else missing.push(t.id);
  }
  if (missing.length > 0) {
    for (const row of await db.select({ id: entries.id, body: entries.body }).from(entries).where(inArray(entries.id, missing))) bodies.set(row.id, row.body);
  }
  return bodies;
}

export async function loadTitleDisplays(
  db: Db,
  // body need not be given. When it is not, this function reads the bodies of the topics without a title only, in one query (the bodies of topics with a title are not read).
  topics: ReadonlyArray<{ id: number; lang: SourceLang; title: string | null; sourceHash: string | null; body?: string }>,
  opts: Pick<DisplayOptions, "readLangs" | "displayLang">,
  // Shared selection preserves saved text; only screen callers opt into typography.
  typeset = false,
): Promise<Map<number, TitleDisplay>> {
  const bodies = await loadTitlelessBodies(db, topics);
  const inputs = topics.map((t) => ({ ...t, kind: "topic" as const }));
  const picked = await loadTopicLineTranslations(db, inputs, opts.displayLang);
  const availability = await loadTranslationAvailability(db, inputs.filter(e => !picked.get(e.id)?.hasBody && wantsTranslation(e.lang, opts.readLangs, opts.displayLang)), [opts.displayLang]);
  const out = new Map<number, TitleDisplay>();
  for (const topic of topics) {
    const line = (await topicLine({ ...topic, body: bodies.get(topic.id) }, picked.get(topic.id), wantsTranslation(topic.lang, opts.readLangs, opts.displayLang), opts.displayLang, typeset));
    out.set(topic.id, {
      text: line.text,
      lang: line.lang,
      kind: line.row?.kind ?? null,
      engine: line.row?.engine ?? null,
      fallback: line.row?.fallback ?? false,
      stale: line.row ? isStale(line.row.flags) : false,
      pending: line.pending && availability.get(availabilityKey(topic.id, opts.displayLang)) !== "unavailable",
      ...(line.pending && availability.get(availabilityKey(topic.id, opts.displayLang)) === "unavailable" ? { unavailable: true } : {}),
      ...(line.row?.flags.includes(FLAG_STRUCTURE_MISMATCH) ? { structureMismatch: true } : {}),
      fromBody: line.fromBody,
    });
  }
  return out;
}
