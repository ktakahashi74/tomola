import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { chatMessageTranslations, chatTranslationReports } from "../db/schema";
import { CHAT_TRANSLATION_REPORT_JOB } from "../chat-translation-reports.server";
import { chatTranslationSource, saveChatTranslation } from "../village-chat-translations.server";
import { lockChatReportTarget } from "../village-chat-reports.server";
import { BudgetPausedError, jobLlmOptions, LlmError, translateChat, type LlmOptions } from "../llm/index.server";
import { CHAT_PROMPT_VERSION } from "../llm/prompt.server";
import { loadGlossary, matchGlossary } from "../translations.server";
import { mentionCandidates } from "../mention-syntax";
import { isLang } from "../languages";
import { villageChatEnabled } from "../village-chat-enabled.server";
import type { JobHandlers } from "./queue.server";
const payloadSchema = z.object({ reportId: z.number().int().positive() }).strict();
export function createChatTranslationReportHandlers(opts: LlmOptions = {}): JobHandlers {
  return { async [CHAT_TRANSLATION_REPORT_JOB](job, ctx) {
    const parsed = payloadSchema.safeParse(job.payload);
    if (!parsed.success) return;
    const [report] = await ctx.db.select().from(chatTranslationReports).where(eq(chatTranslationReports.id, parsed.data.reportId));
    if (!report || report.status !== "retry" || report.retryAttemptedAt || !isLang(report.lang)) return;
    if (!villageChatEnabled()) {
      await ctx.db.update(chatTranslationReports).set({ status: "open" }).where(and(eq(chatTranslationReports.id, report.id), eq(chatTranslationReports.status, "retry")));
      return;
    }
    const payload = { messageId: report.messageId, sourceHash: report.sourceHash, lang: report.lang };
    const source = await chatTranslationSource(ctx.db, payload);
    if (!source || !isLang(source.message.lang)) {
      await ctx.db.update(chatTranslationReports).set({ status: "resolved", handledAt: ctx.now }).where(eq(chatTranslationReports.id, report.id)); return;
    }
    try {
      const result = await translateChat(ctx.db, { text: source.message.body, from: source.message.lang, to: payload.lang, chat: { context: source.context }, glossary: matchGlossary(await loadGlossary(ctx.db, source.message.lang, payload.lang), source.message.body), mentions: mentionCandidates(source.message.body).map(m => source.message.body.slice(m.start, m.end)) }, {
        ...jobLlmOptions(ctx, opts), beforeTranslate: async () => {
          // Persist the consumed slot before any paid call. A crash leaves an
          // open moderator case, never an orphan retry or another paid attempt.
          const claimed = await ctx.db.update(chatTranslationReports).set({ status: "open", retryAttemptedAt: ctx.now }).where(and(eq(chatTranslationReports.id, report.id), eq(chatTranslationReports.status, "retry"))).returning({ id: chatTranslationReports.id });
          if (!claimed.length) throw new Error("Case already handled");
        },
      });
      if (result.flags.length || result.text.replace(/\s+/g, " ").trim() === report.translation?.replace(/\s+/g, " ").trim()) return;
      await ctx.db.transaction(async tx => {
        await lockChatReportTarget(tx, report.messageId);
        const [current] = await tx.select().from(chatTranslationReports).where(eq(chatTranslationReports.id, report.id)).for("update");
        if (current.status !== "open") return;
        const [translation] = await tx.select().from(chatMessageTranslations).where(and(eq(chatMessageTranslations.messageId, report.messageId), eq(chatMessageTranslations.lang, payload.lang)));
        if (translation?.text !== report.translation || translation.state !== "ready") return;
        const saved = await saveChatTranslation(tx, payload, { state: "ready", text: result.text, model: result.model, promptVersion: CHAT_PROMPT_VERSION, errorCode: null });
        if (saved) await tx.update(chatTranslationReports).set({ status: "resolved", handledAt: ctx.now, correctedAt: ctx.now }).where(eq(chatTranslationReports.id, report.id));
      });
    } catch (error) {
      if (error instanceof BudgetPausedError) throw error;
      // Includes engine refusal and failures before the claim. No private error
      // is persisted, and a failed regeneration goes to human review.
      await ctx.db.update(chatTranslationReports).set({ status: "open", retryAttemptedAt: ctx.now }).where(and(eq(chatTranslationReports.id, report.id), eq(chatTranslationReports.status, "retry")));
      if (error instanceof LlmError && error.code === "output_leak") throw error;
    }
  } };
}
