import { and, asc, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { closeDb, getOperatorDb, type Db } from "../app/lib/db/client.server";
import { entries, translations } from "../app/lib/db/schema";
import { tryRenderTranslationHtml } from "../app/lib/entries.server";
import { isLang, isSourceLang } from "../app/lib/languages";
import { FLAG_MARKDOWN_BUDGET, FLAG_OUTPUT_LEAK, FLAG_QUALITY_MISMATCH, HIDDEN_PRIMARY_FLAGS } from "../app/lib/llm/flags";
import { inspectTranslation } from "../app/lib/llm/translate.server";
import { withMarkdownPersistedRead } from "../app/lib/markdown-budget.server";
import { RENDER_VERSION } from "../app/lib/markdown.server";
import { resolveSourceMentions, resolveTranslationMentionsFor } from "../app/lib/mentions.server";
import { prepareResponsePostTranslation } from "../app/lib/response-line.server";
import { parseResponsePost } from "../app/lib/response-post.server";
import { lockReviewableEntry, reviewableWithTopic, rootTopic, rootTopicOn } from "../app/lib/visibility.server";
import { cliOutput, isMain, runCli, type CliOutput } from "./cli";

const BATCH_SIZE = 100;
const hasQualityFlag = sql`${FLAG_QUALITY_MISMATCH} = ANY(${translations.flags})`;

async function recheck(db: Db, apply: boolean): Promise<number[]> {
  const ids: number[] = [];
  let cursor = 0;
  while (true) {
    const rows = await db.select({
      id: translations.id, entryId: entries.id, kind: entries.kind, field: translations.field, translationKind: translations.kind,
      from: entries.lang, to: translations.lang, title: entries.title, body: entries.body,
      sourceHash: entries.sourceHash, entryMentionRevision: entries.mentionRevision, mentionRevision: translations.mentionRevision,
      text: translations.text, engine: translations.engine, flags: translations.flags,
    }).from(translations)
      .innerJoin(entries, eq(entries.id, translations.entryId))
      .innerJoin(rootTopic, rootTopicOn())
      .where(and(gt(translations.id, cursor), inArray(translations.kind, ["primary", "secondary"]), hasQualityFlag,
        reviewableWithTopic(), eq(translations.sourceHash, entries.sourceHash), ne(translations.lang, entries.lang),
        or(isNull(translations.mentionRevision), eq(translations.mentionRevision, entries.mentionRevision))))
      .orderBy(asc(translations.id)).limit(BATCH_SIZE);
    if (rows.length === 0) return ids;
    cursor = rows[rows.length - 1].id;

    for (const row of rows) {
      const { id, entryId, kind, field, from, to, sourceHash } = row;
      if (!sourceHash || !isSourceLang(from) || !isLang(to) ||
          (kind !== "topic" && kind !== "reply") || (field !== "title" && field !== "body")) continue;
      const source = field === "title" ? row.title : row.body;
      if (!source?.trim()) continue;
      const response = field === "body" && kind === "topic" ? await prepareResponsePostTranslation(db, source, from, to) : null;
      const translatedResponse = response ? parseResponsePost(row.text, to) : null;
      if (response && translatedResponse?.topicId !== response.topicId) continue;

      const mentions = field === "body" ? (await resolveSourceMentions(db, source, entryId)).mentions : [];
      const checked = await inspectTranslation({ text: response?.body ?? source, from, to, field, mentions }, translatedResponse?.body ?? row.text, row.engine ?? "");
      // Clear only the preservation flag. Keep any existing display exclusions,
      // and do not expose text when another current exclusion was never stored.
      if (checked.normalizedText !== undefined || checked.flags.some(flag =>
        flag === FLAG_QUALITY_MISMATCH || flag === FLAG_OUTPUT_LEAK || flag === FLAG_MARKDOWN_BUDGET ||
        (HIDDEN_PRIMARY_FLAGS.includes(flag) && !row.flags.includes(flag)))) continue;

      let rendered: Awaited<ReturnType<typeof tryRenderTranslationHtml>> | undefined;
      if (field === "body" && row.translationKind === "primary") {
        const savedMentions = await resolveTranslationMentionsFor(db, [{ id, entryId, sourceHash, mentionRevision: row.mentionRevision }]);
        rendered = await tryRenderTranslationHtml(kind, entryId, to, row.text, savedMentions.get(id) ?? new Map(), true);
        if (!rendered) continue;
      }
      if (!apply) {
        ids.push(id);
        continue;
      }

      const saved = await db.transaction(async tx => {
        const current = await lockReviewableEntry(tx, entryId);
        if (!current || current.sourceHash !== sourceHash || current.mentionRevision !== row.entryMentionRevision) return false;
        const updated = await tx.update(translations).set({
          flags: sql`array_remove(${translations.flags}, ${FLAG_QUALITY_MISMATCH})`,
          updatedAt: new Date(),
          ...(rendered && { html: rendered.html, cardHtml: rendered.cardHtml, htmlVersion: RENDER_VERSION }),
        }).where(and(eq(translations.id, id), eq(translations.sourceHash, sourceHash), eq(translations.text, row.text),
          sql`${translations.mentionRevision} IS NOT DISTINCT FROM ${row.mentionRevision}`,
          sql`${translations.engine} IS NOT DISTINCT FROM ${row.engine}`, eq(translations.flags, row.flags)))
          .returning({ id: translations.id });
        return updated.length > 0;
      });
      if (saved) ids.push(id);
    }
  }
}

export async function runTranslationQualityRecheck(
  args: string[],
  open: () => Promise<Db> = getOperatorDb,
  output: CliOutput = cliOutput,
): Promise<number> {
  if (args.length > 1 || args.some(arg => arg !== "--apply")) {
    output.error("usage: pnpm exec tsx scripts/recheck-translation-quality.ts [--apply]");
    return 1;
  }
  const db = await open();
  try {
    const ids = await withMarkdownPersistedRead(() => recheck(db, args.includes("--apply")));
    output.log(JSON.stringify({ count: ids.length, ids }));
    return 0;
  } finally {
    await closeDb(db);
  }
}

if (isMain(import.meta.url)) process.exitCode = await runCli(() => runTranslationQualityRecheck(process.argv.slice(2)));
