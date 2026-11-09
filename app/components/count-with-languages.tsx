import { m } from "~/paraglide/messages.js";

// The sole count-display component, shared by "なるほど" and stance distributions. Show only the total and how many languages contributed.
// Keep the display policy in this component and its messages so policy changes have one place to update.
//
// Props contract: accept only count (total and langs), kind and a short-label flag. No per-area counts, language names or member information can be passed, as enforced by the types. Fetch no data inside the component
// (no useLoaderData, useRouteLoaderData or fetcher). It does not know its placement (a thread, list item or card). Callers pass Reactions.insightful or
// Distribution.total and Distribution.langs directly.
// Use the same shape even for one language ("なるほど 2（1言語）", "1言語の人が答えています"); the messages handle singular/plural wording. Do not display language names.
export type CountView = { total: number; langs: number };

export function CountWithLanguages({
  count,
  kind,
  short = false,
}: {
  count: CountView;
  // insightful: "なるほど 9（3言語）". stances: "4言語の人が答えています".
  kind: "insightful" | "stances";
  // Omit the repeated action name beside an Insightful button; keep the full accessible label. For stances: the number of languages alone, where the line is short of room.
  short?: boolean;
}) {
  const { total, langs } = count;
  if (kind === "stances") {
    if (total === 0) return <span>{m.stance_none()}</span>;
    const text = m.stance_langs({ langs });
    if (short) return <span><span className="sr-only">{text}</span><span aria-hidden="true">{m.stance_langs_short({ langs })}</span></span>;
    return <span>{text}</span>;
  }
  // Render nothing when the total is zero.
  if (total === 0) return null;
  return (
    <span><span className="sr-only">{m.insightful_count_aria({ total, langs })}</span><span aria-hidden="true">
      {short
        ? m.insightful_count_short({ total, langs })
        : m.insightful_count({ total, langs })}
    </span></span>
  );
}
