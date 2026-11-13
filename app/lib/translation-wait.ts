import { createContext, useContext } from "react";
import { m } from "~/paraglide/messages.js";
import type { TranslationAvailability } from "./translation-availability.server";

// Whether translating is stopped. "normal": a missing translation is only waiting its turn. "stopped": nothing can be translated now (this month's budget
// is used up, there is none, or this job cannot reserve its estimate). A reader is told only that translation is unavailable, the same as for any other technical trouble: neither the budget nor a
// resume day is shown. Posts and chat have separate budgets, hence two states. A translation that failed is a different thing (translation_unavailable).
export type TranslationWait = { kind: "normal" } | { kind: "stopped" };
export type TranslationWaits = { posts: TranslationWait; chat: TranslationWait };

export const NORMAL_WAIT: TranslationWait = { kind: "normal" };
export const NORMAL_WAITS: TranslationWaits = { posts: NORMAL_WAIT, chat: NORMAL_WAIT };

export function translationWaitForAvailability(wait: TranslationWait, availability?: TranslationAvailability): TranslationWait {
  return availability === "paused" ? { kind: "stopped" } : wait;
}

// Provided by the root layout from the root loader; a component rendered outside it (or in a test) sees the ordinary state.
export const TranslationWaitContext = createContext<TranslationWaits>(NORMAL_WAITS);

export function useTranslationWait(scope: keyof TranslationWaits): TranslationWait {
  return useContext(TranslationWaitContext)[scope];
}

// The text for a translation that is not there yet: the ordinary "pending" wording, or the general "unavailable now" wording when translating is stopped.
export function waitText(wait: TranslationWait, short: boolean): string {
  if (wait.kind === "stopped") return short ? m.label_no_translation_short() : m.label_no_translation();
  return short ? m.label_pending_short() : m.label_pending();
}

export function usePendingText(scope: keyof TranslationWaits, short = false, entryWait?: TranslationWait): string {
  const wait = useTranslationWait(scope);
  return waitText(wait.kind === "stopped" ? wait : entryWait ?? wait, short);
}
