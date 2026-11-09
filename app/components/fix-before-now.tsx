import type { Lang } from "~/lib/languages";
import { m } from "~/paraglide/messages.js";

// An appeal against a fix_entry action: the text before the fix and the text now, side by side (the appellant and the reviewer both need to see what changed).
type Text = { title: string | null; body: string };

export function FixBeforeNow({ before, now, lang }: { before: Text | null; now: Text; lang: Lang }) {
  if (before === null) return <p className="mt-2 ui-help" role="status">{m.appeal_fix_pruned()}</p>;
  const column = (label: string, text: Text, testId: string) => (
    <div data-testid={testId} className="min-w-0 space-y-2">
      <p className="ui-meta font-semibold text-muted-foreground">{label}</p>
      {text.title && (
        <p dir="auto" lang={lang} className="font-semibold">
          {text.title}
        </p>
      )}
      <pre dir="auto" lang={lang} className="max-h-64 overflow-auto whitespace-pre-wrap font-sans">
        {text.body}
      </pre>
    </div>
  );
  return (
    <div className="mt-2 grid gap-4 sm:grid-cols-2">
      {column(m.appeal_fix_before(), before, "fix-before")}
      {column(m.appeal_fix_now(), now, "fix-now")}
    </div>
  );
}
