import { cn } from "~/lib/utils";

export function VillageIcon({ src, className }: { src: string; className: string }) {
  if (!src.startsWith("data:image/svg+xml,")) return <img src={src} alt="" className={className} />;
  // Image documents cannot inherit the surrounding ink; use their alpha as a mask.
  return <span data-village-symbol aria-hidden="true" className={cn("block bg-current", className)}
    style={{ mask: `url("${src}") center / contain no-repeat` }} />;
}
