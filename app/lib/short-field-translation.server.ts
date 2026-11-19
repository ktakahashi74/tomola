import type { Db } from "./db/client.server";
import { invitationNoteText, INVITATION_NOTE_TRANSLATED_MAX } from "./invitation-note";
import { FLAG_UNTRANSLATED, HIDDEN_PRIMARY_FLAGS } from "./llm/flags";
import { LlmError, translate, type LlmOptions } from "./llm/index.server";
import { meteredEngine } from "./llm/metering.server";
import { translateChecked } from "./llm/translate.server";
import type { TranslationEngine, TranslationRequest } from "./llm/types";
import { loadGlossary, matchGlossary } from "./translations.server";
import { translatedVillageDescription, translatedVillageName } from "./villages";

const NUSHI_READING_MAX = 2400;

export function nushiReadingTranslator(
  db: Db,
  engine: TranslationEngine,
  options: { clock: () => Date; signal?: AbortSignal },
  rejectsFlag: (flag: string) => boolean,
) {
  const metered = meteredEngine(db, { ...options, purpose: "ask_village" }).translation(engine);
  return async (request: Pick<TranslationRequest, "text" | "from" | "to">) => {
    const result = await translateChecked(metered, { ...request, signal: options.signal });
    return result.text.length > NUSHI_READING_MAX || result.flags.some(rejectsFlag) ? null : result.text;
  };
}

type PlainField = "name" | "description" | "invitationNote";

export async function translatePlainField(
  db: Db, field: PlainField, source: Pick<TranslationRequest, "text" | "from" | "to">, options: LlmOptions,
) {
  const { text, from, to } = source;
  const out = await translate(db, "primary", {
    ...source,
    ...(field === "invitationNote" ? { invitationNote: true } : { village: field }),
    glossary: matchGlossary(await loadGlossary(db, from, to), text),
  }, options);
  const clean = field === "name" ? translatedVillageName(out.text, text)
    : field === "description" ? translatedVillageDescription(out.text, text)
    : invitationNoteText(out.text, INVITATION_NOTE_TRANSLATED_MAX);
  const same = clean?.normalize("NFKC").trim() === text.normalize("NFKC").trim();
  const hidden = out.flags.filter(flag => HIDDEN_PRIMARY_FLAGS.includes(flag));
  // A kept proper name is allowed. An invitation may keep the original only
  // when the normalized text matches and there are no other hidden flags.
  const rejects = hidden.some(flag => flag !== FLAG_UNTRANSLATED || !(field === "name" || field === "invitationNote" && same));
  if (clean === null || rejects || (field === "invitationNote" && (!clean || translatedVillageDescription(clean, text) === null))) {
    const subject = field === "invitationNote" ? "invitation note" : "village";
    throw Object.assign(new LlmError("invalid_output", `The ${subject} translation could not be used`), { retryable: false });
  }
  return { text: clean, same: same || hidden.length > 0, model: out.model, promptVersion: out.promptVersion };
}
