import type { ActiveChatMessage } from "./village-chat";

export type ChatCalendar = { timeZone: string | null; locale: string; now: number };
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(locale: string, timeZone: string, options: Intl.DateTimeFormatOptions) {
  const key = JSON.stringify([locale, timeZone, options]);
  let value = formatters.get(key);
  if (!value) {
    value = new Intl.DateTimeFormat(locale, { ...options, timeZone });
    if (formatters.size >= 100) formatters.delete(formatters.keys().next().value!);
    formatters.set(key, value);
  }
  return value;
}
export function chatDay(iso: string, calendar: ChatCalendar): string {
  if (calendar.timeZone === null) return iso.slice(0, 10);
  const parts = formatter("en", calendar.timeZone, { year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(iso));
  return ["year", "month", "day"].map(type => parts.find(part => part.type === type)!.value).join("-");
}
export function chatClock(iso: string, calendar: ChatCalendar) {
  if (calendar.timeZone === null) return { time: `${iso.slice(11, 16)} UTC`, full: `${iso.slice(0, 16).replace("T", " ")} UTC` };
  const date = new Date(iso);
  const time = formatter(calendar.locale, calendar.timeZone, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
  return { time: calendar.timeZone === "UTC" ? `${time} UTC` : time,
    full: formatter(calendar.locale, calendar.timeZone, { dateStyle: "medium", timeStyle: "short" }).format(date) + (calendar.timeZone === "UTC" ? " UTC" : "") };
}
export function chatDayLabel(iso: string, calendar: ChatCalendar, today: string, yesterday: string, day = chatDay(iso, calendar)) {
  const current = chatDay(new Date(calendar.now).toISOString(), calendar);
  if (day === current) return today;
  // Compare calendar days, including across daylight-saving transitions.
  const [year, month, date] = current.split("-").map(Number);
  const previous = new Date(Date.UTC(year, month - 1, date - 1)).toISOString().slice(0, 10);
  if (day === previous) return yesterday;
  if (calendar.timeZone === null) return day;
  return formatter(calendar.locale, calendar.timeZone, { month: "long", day: "numeric", ...(day.slice(0, 4) !== String(year) ? { year: "numeric" } : {}) }).format(new Date(iso));
}
export function groupChatMessage(previous: ActiveChatMessage | undefined, message: ActiveChatMessage, calendar: ChatCalendar, previousDay = previous ? chatDay(previous.createdAt, calendar) : undefined, day = chatDay(message.createdAt, calendar)) {
  const gap = previous ? Date.parse(message.createdAt) - Date.parse(previous.createdAt) : Infinity;
  return !!previous && !previous.hidden && !message.hidden && !message.edited && !!message.author && previous.author === message.author
    && previousDay === day && gap >= 0 && gap <= 5 * 60_000;
}
