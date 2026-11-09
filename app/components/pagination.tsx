import { Link, useLocation } from "react-router";
import { pageSearch } from "~/lib/pagination";
import { m } from "~/paraglide/messages.js";

// Previous/next links (?page=). Preserve existing query parameters such as ?lang=. Render nothing for a single page.
// anchor identifies the destination position to show, for example #replies.
// dropParams: query parameters that are not carried to the other pages (a one-time state of this page, such as ?select=all of /admin/glossary).
export function Pagination({ page, hasNext, anchor, dropParams, lastPage, pageParam = "page", label, keepFirstPage = false }: { page: number; hasNext: boolean; anchor?: string; dropParams?: readonly string[]; lastPage?: number; pageParam?: string; label?: string; keepFirstPage?: boolean }) {
  const location = useLocation();
  if (page === 1 && !hasNext) return null;
  const search = (() => {
    if (!dropParams?.length) return location.search;
    const params = new URLSearchParams(location.search);
    for (const name of dropParams) params.delete(name);
    const text = params.toString();
    return text ? `?${text}` : "";
  })();
  const to = (target: number) => {
    let query = pageSearch(search, target, pageParam);
    // A section can use an explicit first page to request opening on a full load.
    if (keepFirstPage && target === 1) {
      const params = new URLSearchParams(query);
      params.set(pageParam, "1");
      query = `?${params}`;
    }
    return `${location.pathname}${query}${anchor ?? ""}`;
  };
  return (
    <nav aria-label={label ?? m.page_nav()} className="flex flex-wrap items-center gap-4 ui-meta">
      {page > 1 ? (
        <Link to={to(page - 1)} rel="prev" className="link-ui">
          {m.page_prev()}
        </Link>
      ) : (
        <span className="text-muted-foreground">{m.page_prev()}</span>
      )}
      <span aria-current="page">{m.page_current({ page })}</span>
      {hasNext ? (
        <Link to={to(page + 1)} rel="next" className="link-ui">
          {m.page_next()}
        </Link>
      ) : (
        <span className="text-muted-foreground">{m.page_next()}</span>
      )}
      {lastPage !== undefined && page < lastPage && (
        <Link to={to(lastPage)} className="link-ui">
          {m.page_last()}
        </Link>
      )}
    </nav>
  );
}
