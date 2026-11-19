import { isEnabledLang } from "../enabled-langs.server";
import { jobLlmOptions, type LlmOptions } from "../llm/index.server";
import { LlmError } from "../llm/errors.server";
import { translatePlainField } from "../short-field-translation.server";
import { SAME_AS_SOURCE, saveVillageTranslation, TRANSLATE_VILLAGE_JOB, translatableParts, villageTranslationSettled, villageTranslationSource } from "../village-translations.server";
import { DeferJob, isFinalJobFailure, defineJobHandlers } from "./queue.server";


// translate_village: the name and then the description of one village, into one language, with the same engine, budget and glossary as the posts. Nothing of another member's
// text is sent. An output that the checks hide, or that is not plain text of the right shape (one line for a name, no markup), is not shown: the row is failed and the original is read.
export function createVillageTranslationHandlers(deps: { llm?: LlmOptions } = {}) {
  return defineJobHandlers({ async [TRANSLATE_VILLAGE_JOB](job, ctx) {
    const { payload } = job;
    if (!isEnabledLang(payload.lang)) return;
    if (await villageTranslationSettled(ctx.db, payload)) return;
    const village = await villageTranslationSource(ctx.db, payload);
    if (!village) return;
    const options = jobLlmOptions(ctx, deps.llm);
    const parts = translatableParts(village);
    const result: { name: string | null; description: string | null; model?: string; promptVersion?: string } = { name: null, description: null };
    // A part that comes back as the same characters as its source is not a translation, so it is stored as nothing (the original is read).
    try {
      for (const part of ["name", "description"] as const) {
        const text = parts[part];
        if (text === null) continue;
        const out = await translatePlainField(ctx.db, part, { text, from: village.sourceLang, to: payload.lang }, options);
        result[part] = out.same ? null : out.text;
        result.model = out.model;
        result.promptVersion = out.promptVersion;
      }
    } catch (error) {
      // A wait for the budget is not a failure.
      if (error instanceof DeferJob) throw error;
      if (isFinalJobFailure(job, error)) await saveVillageTranslation(ctx.db, payload, { state: "failed", errorCode: error instanceof LlmError ? error.code : "engine" }, { preserveSettled: true });
      throw error;
    }
    // Nothing came back that is different from the source: there is nothing to translate. The row says so (it is not a failure, and the operator's preparation does not queue it again);
    // the original is read, with no mark of a machine translation.
    if (result.name === null && result.description === null) {
      await saveVillageTranslation(ctx.db, payload, { state: "failed", errorCode: SAME_AS_SOURCE, model: result.model, promptVersion: result.promptVersion }, { preserveSettled: true });
      return;
    }
    await saveVillageTranslation(ctx.db, payload, { state: "ready", name: result.name, description: result.description, model: result.model, promptVersion: result.promptVersion }, { preserveSettled: true });
  } });
}
