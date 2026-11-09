import { z } from "zod";
import { isEnabledLang } from "../enabled-langs.server";
import { FLAG_UNTRANSLATED, HIDDEN_PRIMARY_FLAGS } from "../llm/flags";
import { jobLlmOptions, translate, type LlmOptions } from "../llm/index.server";
import { LlmError } from "../llm/errors.server";
import { loadGlossary, matchGlossary } from "../translations.server";
import { SAME_AS_SOURCE, saveVillageTranslation, TRANSLATE_VILLAGE_JOB, translatableParts, villageTranslationSettled, villageTranslationSource, type VillageTranslationPayload } from "../village-translations.server";
import { translatedVillageDescription, translatedVillageName } from "../villages";
import { DeferJob, type JobHandlers } from "./queue.server";

const payloadSchema = z.object({ villageId: z.string().regex(/^[a-f0-9]{32}$/), lang: z.string().refine(isEnabledLang), sourceHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const unusable = () => Object.assign(new LlmError("invalid_output", "The village translation could not be used"), { retryable: false });

// translate_village: the name and then the description of one village, into one language, with the same engine, budget and glossary as the posts. Nothing of another member's
// text is sent. An output that the checks hide, or that is not plain text of the right shape (one line for a name, no markup), is not shown: the row is failed and the original is read.
export function createVillageTranslationHandlers(deps: { llm?: LlmOptions } = {}): JobHandlers {
  return { async [TRANSLATE_VILLAGE_JOB](job, ctx) {
    const parsed = payloadSchema.safeParse(job.payload);
    if (!parsed.success || !isEnabledLang(parsed.data.lang)) return;
    const payload: VillageTranslationPayload = { ...parsed.data, lang: parsed.data.lang };
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
        const out = await translate(ctx.db, "primary", { text, from: village.sourceLang, to: payload.lang, village: part,
          glossary: matchGlossary(await loadGlossary(ctx.db, village.sourceLang, payload.lang), text) }, options);
        const hidden = out.flags.filter(flag => HIDDEN_PRIMARY_FLAGS.includes(flag));
        // A name that is the same as the source is a valid result (a proper noun is kept as it is): the original name is shown and the description is still translated.
        // A description that is a copy of a text long enough to be translated, and every other hidden flag, still fails the row: that is the engine not translating.
        const keepsName = part === "name" && hidden.every(flag => flag === FLAG_UNTRANSLATED);
        const clean = part === "name" ? translatedVillageName(out.text, text) : translatedVillageDescription(out.text, text);
        if (hidden.length && !keepsName) throw unusable();
        if (clean === null) throw unusable();
        const same = hidden.length > 0 || clean.normalize("NFKC").trim() === text.normalize("NFKC").trim();
        result[part] = same ? null : clean;
        result.model = out.model;
        result.promptVersion = out.promptVersion;
      }
    } catch (error) {
      // A wait for the budget is not a failure.
      if (error instanceof DeferJob) throw error;
      const permanent = error instanceof LlmError && !error.retryable;
      if (permanent || job.attempts >= job.maxAttempts) await saveVillageTranslation(ctx.db, payload, { state: "failed", errorCode: error instanceof LlmError ? error.code : "engine" }, { preserveSettled: true });
      throw error;
    }
    // Nothing came back that is different from the source: there is nothing to translate. The row says so (it is not a failure, and the operator's preparation does not queue it again);
    // the original is read, with no mark of a machine translation.
    if (result.name === null && result.description === null) {
      await saveVillageTranslation(ctx.db, payload, { state: "failed", errorCode: SAME_AS_SOURCE, model: result.model, promptVersion: result.promptVersion }, { preserveSettled: true });
      return;
    }
    await saveVillageTranslation(ctx.db, payload, { state: "ready", name: result.name, description: result.description, model: result.model, promptVersion: result.promptVersion }, { preserveSettled: true });
  } };
}
