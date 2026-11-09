import { ChevronDown } from "lucide-react";
import { Link, useLocation } from "react-router";
import { m } from "~/paraglide/messages.js";

// The filter of a list. Two forms: "all" and "questions only" (?asks=1; the older lists), and, for the cards of the home, also "long posts only" (?long=1; a long post is a
// topic with a title). The current query (?lang=, ?order=) is carried; the page (?page=) goes back to the first. There is no page of its own for questions.
export type ListFilter = "all" | "asks" | "long" | "following";

export function AsksFilter({ asksOnly, filter, withLong = false, withFollowing = false, collapsed = false }: { asksOnly?: boolean; filter?: ListFilter; withLong?: boolean; withFollowing?: boolean; collapsed?: boolean }) {
  const location = useLocation();
  const prefix = m.filter_prefix();
  const current: ListFilter = filter ?? (asksOnly ? "asks" : "all");
  const to = (target: ListFilter) => {
    const params = new URLSearchParams(location.search);
    params.delete("page");
    params.delete("asks");
    params.delete("long");
    params.delete("follow");
    if (target === "following") params.set("follow", "1");
    if (target === "asks") params.set("asks", "1");
    if (target === "long") params.set("long", "1");
    const search = params.toString();
    return `${location.pathname}${search ? `?${search}` : ""}`;
  };
  const item = (target: ListFilter, label: string) => (
    <Link to={to(target)} aria-current={current === target ? "true" : undefined} className="choice">
      {label}
    </Link>
  );
  const links = (
    <nav aria-label={m.list_filter_label()} className="flex flex-wrap items-center gap-x-4 gap-y-1 ui-meta">
      {item("all", withLong ? m.home_filter_all() : m.list_all_topics())}
      {item("asks", m.list_questions_only())}
      {withLong && item("long", m.home_filter_long())}
      {withFollowing && item("following", m.home_filter_following())}
    </nav>
  );
  if (!collapsed) return links;
  const currentLabel = current === "asks" ? m.list_questions_only() : current === "long" ? m.home_filter_long() : current === "following" ? m.home_filter_following() : m.home_filter_all();
  // The name "Filter:" is not drawn: the chosen value says it. The accessible name keeps it.
  const summaryLabel = `${prefix}${prefix.endsWith("：") ? "" : " "}${currentLabel}`;
  return <details key={location.key} className="ui-meta text-muted-foreground">
    <summary aria-label={summaryLabel} className={`link-ui inline-flex min-h-6 cursor-pointer list-none items-center gap-0.5 whitespace-nowrap [&::-webkit-details-marker]:hidden ${current !== "all" ? "font-medium text-foreground" : ""}`}>{currentLabel}<ChevronDown aria-hidden="true" className="size-3" /></summary>
    <div className="absolute inset-x-0 top-full z-20 mt-1 rounded-lg border bg-popover p-3 shadow-md">{links}</div>
  </details>;
}
