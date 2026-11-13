import { and, eq, isNull } from "drizzle-orm";
import { nushiAnswers, nushiTranslations } from "./db/schema";
import { isEnabledLang } from "./enabled-langs.server";
import { readNushiAnswer } from "./nushi.server";
import { resolveEngines } from "./llm/config.server";
import { translateChecked } from "./llm/translate.server";
import { meteredCall, translationEstimate } from "./llm/metering.server";
import { HIDDEN_PRIMARY_FLAGS } from "./llm/flags";
import { BudgetPausedError } from "./llm/errors.server";
import type { SourceLang } from "./languages";
import type { JobHandlers } from "./jobs/queue.server";

export function createNushiTranslationHandlers(): JobHandlers {
  return { async translate_nushi(job, ctx) {
    const payload = job.payload as { answerId?: unknown; lang?: unknown };
    if (typeof payload.answerId !== "number" || !isEnabledLang(payload.lang)) return;
    const id = payload.answerId, lang = payload.lang;
    const value = await readNushiAnswer(ctx.db, id);
    if (!value || value.hidden || value.originalLang === lang || !value.answer.readings.length) return;
    const [saved] = await ctx.db.select().from(nushiTranslations).where(and(eq(nushiTranslations.answerId, id), eq(nushiTranslations.lang, lang)));
    if (saved) return;
    const clock = ctx.clock ?? (() => new Date()), engine = resolveEngines().primary;
    if (!engine) return;
    try {
      const readings: string[] = [];
      // Translate only generated summaries. Human quotations and destinations
      // retain their checked original and supplied translation side by side.
      for (const reading of value.answer.readings) {
        const current = await readNushiAnswer(ctx.db, id);
        if (!current || current.hidden) return;
        const out = await translateChecked({ ...engine, async translate(req) {
          const { result } = await meteredCall(ctx.db, { engine: engine.id, model: engine.model, purpose: "ask_village", role: "ask",
            estimateMicro: translationEstimate(engine.id, engine.model, req), now: clock(), clock, signal: ctx.signal },
          () => engine.translate({ ...req, signal: ctx.signal }), result => ({ inputTokens: result.inputTokens, outputTokens: result.outputTokens }));
          return result;
        } }, { text: reading.text, from: value.originalLang as SourceLang, to: lang, signal: ctx.signal });
        if (out.flags.some(flag => HIDDEN_PRIMARY_FLAGS.includes(flag)) || out.text.length > 2400) return;
        readings.push(out.text);
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
  } };
}
