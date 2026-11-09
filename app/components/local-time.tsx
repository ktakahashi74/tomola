import { useEffect, useState } from "react";
import { afterInitialActivation } from "~/lib/initial-activation";
import { formatTime, type FormattedTime, type TimeStyle } from "~/lib/time-format";
import { getLocale } from "~/paraglide/runtime.js";

// Keep SSR and the first browser render identical (UTC, with the zone named when a clock time is shown), then use the viewer's time zone.
// Use "date" for article headers, "stamp" for replies and revisions, and "short" for lists.
export function LocalTime({ iso, className, formatLabel, style = "short" }: { iso: string; className?: string; formatLabel?: (time: string) => string; style?: TimeStyle }) {
  const [local, setLocal] = useState<{ iso: string; shown: FormattedTime } | null>(null);
  useEffect(() => afterInitialActivation(() => {
    setLocal({ iso, shown: formatTime(iso, { now: new Date(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, locale: getLocale(), style }) });
  }), [iso, style]);
  const fallback = formatTime(iso, { now: new Date(), timeZone: "UTC", locale: getLocale(), style, zoneLabel: true });
  const shown = local?.iso === iso ? local.shown : fallback;
  return <time dateTime={iso} title={shown.full} className={className} suppressHydrationWarning>{formatLabel ? formatLabel(shown.text) : shown.text}</time>;
}
