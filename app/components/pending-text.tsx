import { usePendingText, type TranslationWait, type TranslationWaits } from "~/lib/translation-wait";

// "Translation pending", or why it is paused when the month's budget is used up (app/lib/translation-wait.ts).
export function PendingText({ scope = "posts", short = false, wait }: { scope?: keyof TranslationWaits; short?: boolean; wait?: TranslationWait }) {
  return <>{usePendingText(scope, short, wait)}</>;
}
