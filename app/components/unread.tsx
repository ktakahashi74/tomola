import { cn } from "~/lib/utils";

// The two marks for "not seen yet" (a dot and a count). Use these and no other form; the colour comes from the "unread" state variable in app/app.css.
// UnreadDot: something new is here (no number). CountBadge: a number the reader must answer (see the rule of the number in the navigation). Neither moves or grows.

// `label` is read out; leave it out where the text beside the dot already says it is new.
export function UnreadDot({ label, className }: { label?: string; className?: string }) {
  return <><span aria-hidden="true" className={cn("inline-block size-2 shrink-0 rounded-full bg-unread", className)} />{label && <span className="sr-only">{label}</span>}</>;
}

// tone "quiet": a grey ground. tone "strong": an ink ground with white text. The count over `cap` shows as "cap+" (99+).
export function CountBadge({ count, label, tone = "quiet", cap = 99, className }: { count: number; label: string; tone?: "quiet" | "strong"; cap?: number; className?: string }) {
  if (count <= 0) return null;
  const text = count > cap ? `${cap}+` : String(count);
  return <span role="img" aria-label={label} title={label} className={cn(
    "inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 ui-meta font-medium leading-none",
    tone === "strong" ? "bg-primary text-primary-foreground" : "bg-secondary text-secondary-foreground",
    className,
  )}><span aria-hidden="true">{text}</span></span>;
}
