import { villageDescriptionText } from "./villages";

export const INVITATION_NOTE_MAX = 300;
export const INVITATION_NOTE_TRANSLATED_MAX = INVITATION_NOTE_MAX * 2;

// A short, single-line message. Keep script-shaping joiners, as village names do.
export function invitationNoteText(value: unknown, max = INVITATION_NOTE_MAX): string | null {
  if (typeof value !== "string" || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)) return null;
  return villageDescriptionText(value, max);
}
