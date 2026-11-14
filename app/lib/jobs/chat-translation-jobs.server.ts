import { CHAT_NUSHI_PROMPT_VERSION } from "../chat-nushi-config.server";
import { translateChatNushi } from "../chat-nushi-translation.server";
import { loadGlossary, matchGlossary } from "../translations.server";
import { createChatTranslationReportHandlers } from "./chat-translation-report-jobs.server";
import { z } from "zod";
import { isEnabledLang } from "../enabled-langs.server";
import { villageChatEnabled } from "../village-chat-enabled.server";
import { chatTranslationSettled, chatTranslationSource, saveChatTranslation } from "../village-chat-translations.server";
import { BudgetPausedError, jobLlmOptions, LlmError, translateChat, type LlmOptions } from "../llm/index.server";
import { CHAT_PROMPT_VERSION } from "../llm/prompt.server";
import { NEAR_COPY_FLAGS } from "../llm/flags";
import { mentionCandidates } from "../mention-syntax";
import { isLang } from "../languages";
import { DeferJob, isFinalJobFailure, jobAttemptLimit, type JobHandlers } from "./queue.server";

const payloadSchema = z.object({ messageId: z.string().regex(/^[a-f0-9]{32}$/), lang: z.string().refine(isEnabledLang), sourceHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
class SettledTranslation extends Error {}
export function createChatTranslationHandlers(opts: LlmOptions = {}): JobHandlers {
  const handler: JobHandlers[string] = async (job, ctx) => {
    if (!villageChatEnabled()) return;
    const parsed = payloadSchema.safeParse(job.payload);
    if (!parsed.success || !isEnabledLang(parsed.data.lang)) return;
    const payload = { ...parsed.data, lang: parsed.data.lang };
    if (await chatTranslationSettled(ctx.db, payload)) return;
    const source = await chatTranslationSource(ctx.db, payload);
    if (!source || !isLang(source.message.lang)) return;
    const save = (update: Parameters<typeof saveChatTranslation>[2]) => saveChatTranslation(ctx.db, payload, update, { preserveSettled: true });
    let fallbackReason: string | undefined;
    try {
      const result = source.message.authorKind === "nushi"
        ? await translateChatNushi(ctx.db, source.message, payload.lang, { clock: ctx.clock ?? (() => ctx.now), signal: ctx.signal })
        : await translateChat(ctx.db, { text: source.message.body, from: source.message.lang, to: payload.lang,
        glossary: matchGlossary(await loadGlossary(ctx.db, source.message.lang, payload.lang), source.message.body),
        chat: { context: source.context }, mentions: mentionCandidates(source.message.body).map(m => source.message.body.slice(m.start, m.end)),
      }, { ...jobLlmOptions(ctx, opts), beforeTranslate: async () => {
        await save({ state: "pending", errorCode: null });
        if (await chatTranslationSettled(ctx.db, payload)) throw new SettledTranslation();
      } });
      // Unusable output falls back to source text; never publish a translation
      // which introduced links, lost mentions or failed structural checks.
      if (result.flags.length) {
        // Only near-copy checks can quietly fall back; mixed safety failures
        // keep the ordinary failure notice and remain terminal as before.
        if (result.flags.every(flag => NEAR_COPY_FLAGS.includes(flag))) fallbackReason = result.flags[0];
        throw Object.assign(new LlmError("invalid_output", "Chat translation checks failed"), { retryable: false });
      }
      await save({ state: "ready", text: result.text, model: result.model, promptVersion: source.message.authorKind === "nushi" ? CHAT_NUSHI_PROMPT_VERSION : CHAT_PROMPT_VERSION, errorCode: null });
    } catch (error) {
      if (error instanceof SettledTranslation) return;
      if (error instanceof BudgetPausedError) {
        await save({ state: "paused", errorCode: "budget" });
        throw error;
      }
      const code = fallbackReason ?? (error instanceof LlmError ? error.code : "engine");
      if (isFinalJobFailure(job, error)) await save({ state: "failed", errorCode: code });
      // Provider/SQL errors can include source or context. Persist only a fixed
      // category, never an error message, cause or response body.
      throw Object.assign(new Error(`Chat translation failed (${code})`), { retryable: !(error instanceof LlmError && !error.retryable), maxAttempts: jobAttemptLimit(job, error) });
    }
  };
  return { ...createChatTranslationReportHandlers(opts), async translate_chat(job, ctx) {
    try { await handler(job, ctx); }
    catch (error) {
      if (error instanceof DeferJob) throw error;
      throw Object.assign(new Error("Chat translation failed"), { retryable: !(typeof error === "object" && error !== null && "retryable" in error && error.retryable === false), maxAttempts: jobAttemptLimit(job, error) });
    }
  } };
}
export const chatJobHandlers = createChatTranslationHandlers();
