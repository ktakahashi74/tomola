import { and, eq, isNull } from "drizzle-orm";
import { nushiAnswers, nushiTranslations } from "./db/schema";
import { isEnabledLang } from "./enabled-langs.server";
import { readNushiAnswer } from "./nushi.server";
import { resolveEngines } from "./llm/config.server";
import { nushiReadingTranslator } from "./short-field-translation.server";
import { HIDDEN_PRIMARY_FLAGS } from "./llm/flags";
import { BudgetPausedError } from "./llm/errors.server";
import type { SourceLang } from "./languages";
import { defineJobHandlers } from "./jobs/queue.server";

export function createNushiTranslationHandlers() {
  return defineJobHandlers({ async translate_nushi(job, ctx) {
    const { answerId: id, lang } = job.payload;
    if (!isEnabledLang(lang)) return;
    const value = await readNushiAnswer(ctx.db, id);
    if (!value || value.hidden || value.originalLang === lang || !value.answer.readings.length) return;
    const [saved] = await ctx.db.select().from(nushiTranslations).where(and(eq(nushiTranslations.answerId, id), eq(nushiTranslations.lang, lang)));
    if (saved) return;
    const clock = ctx.clock ?? (() => new Date()), engine = resolveEngines().primary;
    if (!engine) return;
    const translateReading = nushiReadingTranslator(ctx.db, engine, { clock, signal: ctx.signal }, flag => HIDDEN_PRIMARY_FLAGS.includes(flag));
    try {
      const readings: string[] = [];
      // Translate only generated summaries. Human quotations and destinations
      // retain their checked original and supplied translation side by side.
      for (const reading of value.answer.readings) {
        const current = await readNushiAnswer(ctx.db, id);
        if (!current || current.hidden) return;
        const text = await translateReading({ text: reading.text, from: value.originalLang as SourceLang, to: lang });
        if (text === null) return;
        readings.push(text);
      }
      await ctx.db.transaction(async tx => {
        await tx.select({ id: nushiAnswers.id }).from(nushiAnswers).where(eq(nushiAnswers.id, id)).for("share");
        const current = await readNushiAnswer(tx, id);
        if (!current || current.hidden) return;
        await tx.insert(nushiTranslations).values({ answerId: id, lang, readings, engine: engine.id, model: engine.model }).onConflictDoNothing();
      });
    } catch (error) {
      if (error instanceof BudgetPausedError) throw error;
      // The queue must never retain a provider error containing post text.
      throw new Error("Nushi translation is temporarily unavailable");
    }
  } });
}
