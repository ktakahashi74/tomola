import type { ReactNode } from "react";
import { PersistentDetails } from "~/components/persistent-details";
import { m } from "~/paraglide/messages.js";

// The decisions that come with a piece of writing (where it goes and which language it uses) are not put in front of the writing. They are one line beside the
// post button that says what will happen ("Public in Japanese · Language: automatic"), and "Change" opens the controls under it. The line is the confirmation:
// nothing is asked again after the button is pressed. The controls stay in the page (a closed <details>) so that the form works without JavaScript.
export function PostSettings({ summary, children, open = false }: { summary: ReactNode; children: ReactNode; open?: boolean }) {
  return <PersistentDetails open={open} data-post-settings className="min-w-0">
    <summary className="inline-flex max-w-full cursor-pointer list-none flex-wrap items-center gap-x-1.5 ui-meta text-muted-foreground [&::-webkit-details-marker]:hidden">
      <span>{summary}</span><span aria-hidden="true">·</span><span className="underline">{m.post_settings_change()}</span>
    </summary>
    <div className="mt-2 space-y-3 rounded-lg border p-3">{children}</div>
  </PersistentDetails>;
}
