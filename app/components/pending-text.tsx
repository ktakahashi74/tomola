import { usePendingText, type TranslationWaits } from "~/lib/translation-wait";

// "Translation pending", or why it is paused when the month's budget is used up (app/lib/translation-wait.ts).
export function PendingText({ scope = "posts", short = false }: { scope?: keyof TranslationWaits; short?: boolean }) {
  return <>{usePendingText(scope, short)}</>;
}
