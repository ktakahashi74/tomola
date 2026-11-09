import { and, eq, inArray, isNotNull, or } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { entries, translations } from "~/lib/db/schema";
import { isStale, pickTranslation, SHOWN_KINDS, type ShownKind } from "~/lib/display";
import { enabledLangs } from "~/lib/enabled-langs.server";
import type { Lang } from "~/lib/languages";
import { loadReportNotices } from "~/lib/translation-reports.server";
import { FLAG_STRUCTURE_MISMATCH } from "~/lib/llm/flags";
import { localizeResponseBodies } from "../response-line.server";

// Twin translation selection matches pickTranslation in app/lib/display.ts: current-source human > primary.
// Only current-source primary rows are eligible. Stale human output is shown with stale flag only if no current primary exists.
// Available display languages are those with selectable body translations.

// Translation-kind to twin status mapping, documented in /llms.txt and /help/ai.md.
export const TRANSLATION_STATUS: Record<ShownKind, "machine" | "human_edited"> = {
  primary: "machine",
  human: "human_edited",
};

export type MdTranslation = {
  id: number;
  sourceHash: string | null;
  titleId: number | null;
  lang: Lang;
  status: (typeof TRANSLATION_STATUS)[ShownKind];
  engine: string | null;
  model: string | null;
  // Machine translation from the secondary after primary refusal/failure.
  fallback: boolean;
  stale: boolean;
  structureMismatch?: boolean;
  text: string;
  // Translated title, topics only; null if absent.
  title: string | null;
  // Report notice: open warns the reading AI to check the original; retranslated means higher-tier report retry. Null if absent.
  report: "open" | "retranslated" | null;
};

// retranslated applies only when the displayed translation is the retranslated machine output.
function reportOf(notice: "open" | "retried" | undefined, status: "machine" | "human_edited"): MdTranslation["report"] {
  if (notice === "open") return "open";
  return notice === "retried" && status === "machine" ? "retranslated" : null;
}

export type MdTranslationInput = { id: number; lang: Lang; sourceHash: string | null };

// For each post, reads the languages of the translations that can be shown (the enabled languages (ENABLED_LANGS) in the order of LANGS, without the original language; a translation
// into a language that is not enabled is not used even if its row remains) and the requested translations.
// Read body/title rows without body text first; select, then load text only for the selected rows. "all" selects every enabled target language.
export async function loadMdTranslations(
  db: Db,
  inputs: readonly MdTranslationInput[],
  wantLang: Lang | "all" | null,
): Promise<{ langs: Map<number, Lang[]>; shown: Map<number, MdTranslation[]> }> {
  const langs = new Map<number, Lang[]>();
  const shown = new Map<number, MdTranslation[]>();
  if (inputs.length === 0) return { langs, shown };
  const rows = await db
    .select({
      id: translations.id,
      entryId: translations.entryId,
      field: translations.field,
      lang: translations.lang,
      kind: translations.kind,
      sourceHash: translations.sourceHash,
      flags: translations.flags,
    })
    .from(translations)
    // A title translation counts only while the topic has a title (after the title is removed, the old rows stay in the table but are not shown).
    .innerJoin(entries, eq(entries.id, translations.entryId))
    .where(and(inArray(translations.entryId, inputs.map((e) => e.id)), inArray(translations.kind, [...SHOWN_KINDS]), or(eq(translations.field, "body"), isNotNull(entries.title))));

  type Row = (typeof rows)[number];
  const byEntry = new Map<number, Row[]>();
  for (const row of rows) {
    const list = byEntry.get(row.entryId);
    if (list) list.push(row);
    else byEntry.set(row.entryId, [row]);
  }
  // Selected body/title rows in enabled-language order; text read later in one batch.
  const wanted: { entry: MdTranslationInput; body: Row; title: Row | null }[] = [];
  const enabled = enabledLangs();
  for (const entry of inputs) {
    const mine = byEntry.get(entry.id) ?? [];
    const found: Lang[] = [];
    for (const lang of enabled) {
      if (lang === entry.lang) continue;
      const here = mine.filter((r) => r.lang === lang);
      const body = pickTranslation(here.filter((r) => r.field === "body"), entry.sourceHash);
      if (!body) continue;
      found.push(lang);
      if (wantLang === "all" || lang === wantLang) wanted.push({ entry, body, title: pickTranslation(here.filter((r) => r.field === "title"), entry.sourceHash) });
    }
    langs.set(entry.id, found);
  }
  if (wanted.length === 0) return { langs, shown };

  const notices = await loadReportNotices(
    db,
    wanted.map(({ entry, body }) => ({ entryId: entry.id, lang: body.lang as Lang, sourceHash: entry.sourceHash })),
  );
  const ids = wanted.flatMap((w) => [w.body.id, ...(w.title ? [w.title.id] : [])]);
  const texts = await localizeResponseBodies(db, await db
    .select({ id: translations.id, entryId: translations.entryId, field: translations.field, kind: translations.kind, lang: translations.lang, text: translations.text, engine: translations.engine, model: translations.model, fallback: translations.fallback })
    .from(translations)
    .where(inArray(translations.id, ids)));
  const textOf = new Map(texts.map((t) => [t.id, t]));
  for (const { entry, body, title } of wanted) {
    const bodyText = textOf.get(body.id);
    if (!bodyText) continue;
    const selected = shown.get(entry.id) ?? [];
    selected.push({
      id: body.id,
      sourceHash: body.sourceHash,
      titleId: title?.id ?? null,
      lang: body.lang as Lang,
      status: TRANSLATION_STATUS[body.kind as ShownKind],
      engine: bodyText.engine,
      model: bodyText.model,
      fallback: bodyText.fallback,
      stale: isStale(body.flags) || (title ? isStale(title.flags) : false),
      ...(body.flags.includes(FLAG_STRUCTURE_MISMATCH) || title?.flags.includes(FLAG_STRUCTURE_MISMATCH) ? { structureMismatch: true } : {}),
      text: bodyText.text,
      title: title ? (textOf.get(title.id)?.text ?? null) : null,
      report: reportOf(notices.get(`${entry.id}:${body.lang}`), TRANSLATION_STATUS[body.kind as ShownKind]),
    });
    shown.set(entry.id, selected);
  }
  return { langs, shown };
}
