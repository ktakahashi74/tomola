import type { ReactNode } from "react";

type MetaItem = { key: string; content: ReactNode; badge?: boolean };

// Keep word boundaries for reading and copying when visual spacing separates items.
export function ListMeta({ items }: { items: (MetaItem | false | null | undefined)[] }) {
  const visible = items.filter((item): item is MetaItem => !!item);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 ui-meta text-muted-foreground" data-list-meta="">
      {visible.map((item, index) => (
        <span key={item.key} className="inline-flex min-w-0 max-w-full items-center gap-x-2" data-meta-item={item.badge ? "badge" : "text"}>
          {item.content}
          {visible[index + 1] && <span className="sr-only"> </span>}
        </span>
      ))}
    </div>
  );
}
