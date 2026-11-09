import type * as core from "./copy-detection.core.server";
import { markdownTask } from "../markdown-budget.server";
export { EXACT_MIN_CONTENT_LETTERS, NEAR_MIN_CONTENT_LETTERS, NEAR_COPY_SIMILARITY, TARGET_SCRIPT_MIN_SHARE, type CopyVerdict } from "./copy-detection.core.server";

export function detectCopy(...args: Parameters<typeof core.detectCopy>): Promise<ReturnType<typeof core.detectCopy>> {
  return markdownTask("detectCopy", args);
}

export function contentLetters(...args: Parameters<typeof core.contentLetters>): Promise<ReturnType<typeof core.contentLetters>> {
  return markdownTask("contentLetters", args);
}

export function bigramDice(...args: Parameters<typeof core.bigramDice>): Promise<ReturnType<typeof core.bigramDice>> {
  return markdownTask("bigramDice", args);
}
