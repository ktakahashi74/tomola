// The one rule for showing a time (S6).
// "short" (lists, notifications, search, settings): today the time, yesterday the word, this year month and day, an earlier year the full date.
// "stamp" (the line of a post or a reply): month and day with the time; with the year when it is not this year.
// "date" (article headers): the full calendar date, through the day.
// The title (shown under the pointer) is the full date and time in the reader's language and time zone, never the raw ISO string.
export type TimeStyle = "short" | "stamp" | "date";

export type FormattedTime = { text: string; full: string; showsTime: boolean };

// One formatter per language, time zone and set of options: a long list asks for the same few again and again.
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(locale: string, timeZone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${timeZone}|${JSON.stringify(options)}`;
  let found = formatters.get(key);
  if (!found) formatters.set(key, found = new Intl.DateTimeFormat(locale, { ...options, timeZone }));
  return found;
}

function ymd(date: Date, timeZone: string): { y: number; m: number; d: number } {
  const parts = formatter("en-US", timeZone, { year: "numeric", month: "numeric", day: "numeric" }).formatToParts(date);
  const pick = (type: string) => Number(parts.find(p => p.type === type)?.value);
  return { y: pick("year"), m: pick("month"), d: pick("day") };
}

// Whole days from `then` to `now` on the calendar of `timeZone`.
function calendarDays(then: Date, now: Date, timeZone: string): number {
  const a = ymd(then, timeZone), b = ymd(now, timeZone);
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86_400_000);
}

export function formatTime(iso: string, opts: { now: Date; timeZone: string; locale: string; style: TimeStyle; zoneLabel?: boolean }): FormattedTime {
  const { now, timeZone, locale, style } = opts;
  const date = new Date(iso);
  const fmt = (options: Intl.DateTimeFormatOptions) => formatter(locale, timeZone, options).format(date);
  const sameYear = ymd(date, timeZone).y === ymd(now, timeZone).y;
  const days = calendarDays(date, now, timeZone);
  const time = () => fmt({ hour: "numeric", minute: "2-digit", ...(opts.zoneLabel ? { timeZoneName: "short" } : {}) });
  const dayText = () => fmt({ month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
  const full = fmt({ dateStyle: "long", timeStyle: opts.zoneLabel ? "long" : "short" });
  if (style === "date") return { text: fmt({ year: "numeric", month: "long", day: "numeric" }), full, showsTime: false };
  if (style === "stamp") return { text: `${dayText()} ${time()}`, full, showsTime: true };
  if (days === 0) return { text: time(), full, showsTime: true };
  if (days === 1) {
    const word = new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(-1, "day");
    return { text: word.charAt(0).toLocaleUpperCase(locale) + word.slice(1), full, showsTime: false };
  }
  return { text: dayText(), full, showsTime: false };
}
