import { isEnabledLang } from "../enabled-langs.server";
import { invitationNoteSource, saveInvitationNoteTranslation, TRANSLATE_INVITATION_NOTE_JOB } from "../invitation-note.server";
import { jobLlmOptions, type LlmOptions } from "../llm/index.server";
import { translatePlainField } from "../short-field-translation.server";
import { DeferJob, isFinalJobFailure, defineJobHandlers } from "./queue.server";


export function createInvitationNoteHandlers(deps: { llm?: LlmOptions } = {}) {
  return defineJobHandlers({ async [TRANSLATE_INVITATION_NOTE_JOB](job, ctx) {
    const { payload } = job;
    if (!isEnabledLang(payload.lang)) return;
    const source = await invitationNoteSource(ctx.db, payload);
    if (!source) return;
    try {
      const out = await translatePlainField(ctx.db, "invitationNote", { ...source, to: payload.lang }, jobLlmOptions(ctx, deps.llm));
      await saveInvitationNoteTranslation(ctx.db, payload, { state: "ready", text: out.text, model: out.model, promptVersion: out.promptVersion });
    } catch (error) {
      if (error instanceof DeferJob) throw error;
      if (isFinalJobFailure(job, error)) await saveInvitationNoteTranslation(ctx.db, payload, { state: "failed" });
      throw error;
    }
  } });
}
