import { z } from "zod";
import { isEnabledLang } from "../enabled-langs.server";
import { invitationNoteText, INVITATION_NOTE_TRANSLATED_MAX } from "../invitation-note";
import { invitationNoteSource, saveInvitationNoteTranslation, TRANSLATE_INVITATION_NOTE_JOB } from "../invitation-note.server";
import { FLAG_UNTRANSLATED, HIDDEN_PRIMARY_FLAGS } from "../llm/flags";
import { jobLlmOptions, LlmError, translate, type LlmOptions } from "../llm/index.server";
import { loadGlossary, matchGlossary } from "../translations.server";
import { translatedVillageDescription } from "../villages";
import { DeferJob, type JobHandlers } from "./queue.server";

const schema = z.object({ invitationId: z.string().uuid(), lang: z.string().refine(isEnabledLang) }).strict();

export function createInvitationNoteHandlers(deps: { llm?: LlmOptions } = {}): JobHandlers {
  return { async [TRANSLATE_INVITATION_NOTE_JOB](job, ctx) {
    const parsed = schema.safeParse(job.payload);
    if (!parsed.success || !isEnabledLang(parsed.data.lang)) return;
    const payload = { invitationId: parsed.data.invitationId, lang: parsed.data.lang };
    const source = await invitationNoteSource(ctx.db, payload);
    if (!source) return;
    try {
      const out = await translate(ctx.db, "primary", { ...source, to: payload.lang, invitationNote: true,
        glossary: matchGlossary(await loadGlossary(ctx.db, source.from, payload.lang), source.text) }, jobLlmOptions(ctx, deps.llm));
      const text = invitationNoteText(out.text, INVITATION_NOTE_TRANSLATED_MAX);
      const same = text?.normalize("NFKC").trim() === source.text.normalize("NFKC").trim();
      if (!text || translatedVillageDescription(text, source.text) === null || out.flags.some(flag => HIDDEN_PRIMARY_FLAGS.includes(flag) && !(same && flag === FLAG_UNTRANSLATED))) {
        throw Object.assign(new LlmError("invalid_output", "The invitation note translation could not be used"), { retryable: false });
      }
      await saveInvitationNoteTranslation(ctx.db, payload, { state: "ready", text, model: out.model, promptVersion: out.promptVersion });
    } catch (error) {
      if (error instanceof DeferJob) throw error;
      if ((error instanceof LlmError && !error.retryable) || job.attempts >= job.maxAttempts) await saveInvitationNoteTranslation(ctx.db, payload, { state: "failed" });
      throw error;
    }
  } };
}
