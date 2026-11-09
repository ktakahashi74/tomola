import { m } from "~/paraglide/messages.js";
import { getLocale } from "~/paraglide/runtime.js";

export type MentionSuggestion = { handle: string; label: string | null };

export async function fetchSuggestions(query: string, village: string | undefined, signal: AbortSignal): Promise<MentionSuggestion[]> {
  const response = await fetch(`/mentions/suggest?q=${encodeURIComponent(query.normalize("NFKC").toLowerCase())}&lang=${getLocale()}${village === undefined ? "" : `&village=${encodeURIComponent(village)}`}`, { credentials: "same-origin", signal, headers: { accept: "application/json" } });
  if (!response.ok) return [];
  const body = await response.json() as { handles?: unknown; names?: Record<string, { label?: string | null }> };
  return Array.isArray(body.handles) ? body.handles.flatMap(handle => typeof handle === "string" ? [{ handle, label: body.names?.[handle]?.label ?? null }] : []) : [];
}

// Only the open suggestion list needs display labels and its presentation code.
export default function MentionSuggestions({ id, items, active, choose }: { id: string; items: MentionSuggestion[]; active: number; choose: (handle: string) => void }) {
  return <ul id={id} role="listbox" aria-label={m.mention_suggestions_label()} className="absolute start-0 top-full z-10 mt-1 max-h-48 min-w-40 overflow-auto rounded border bg-popover py-1 shadow">
    {items.map(({ handle, label }, index) => <li key={handle} id={`${id}-${index}`} role="option" aria-selected={index === active}
      onMouseDown={event => { event.preventDefault(); choose(handle); }} className={`cursor-pointer px-3 py-1 ${index === active ? "bg-info" : ""}`}>
      {label && <bdi>{label} </bdi>}@{handle}
    </li>)}
  </ul>;
}
