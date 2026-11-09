import { Link, useLocation } from "react-router";
import type { TopicOrder } from "~/lib/entries.server";
import { m } from "~/paraglide/messages.js";

// The switch of the order of the stream: "Newest" (the order they were posted: the default), "Latest replies" (the last activity first), and "Most Insightful". Three links; the current one is marked (the "choice" class).
// The current query (?lang=, the filter) is carried and the page goes back to the first. The default order has no ?order= in its link.
export function OrderSwitch({ order, compact = false }: { order: TopicOrder; compact?: boolean }) {
  const location = useLocation();
  const to = (target: TopicOrder) => {
    const params = new URLSearchParams(location.search);
    params.delete("page");
    params.delete("manage");
    if (target !== "created") params.set("order", target);
    else params.delete("order");
    const search = params.toString();
    return `${location.pathname}${search ? `?${search}` : ""}`;
  };
  const item = (target: TopicOrder, label: string) => (
    <Link to={to(target)} aria-current={order === target ? "page" : undefined} className="choice">
      {label}
    </Link>
  );
  return (
    <nav aria-label={m.home_order_label()} className={`flex flex-wrap items-center ${compact ? "gap-x-2" : "gap-x-4"} gap-y-1 ui-meta`}>
      {item("created", m.home_order_created())}
      {item("activity", m.home_order_activity())}
      {item("insightful", m.home_order_insightful())}
    </nav>
  );
}
