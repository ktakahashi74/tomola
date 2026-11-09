import { expect, it } from "vitest";
import { formatTime } from "~/lib/time-format";

const now = new Date("2026-10-24T12:00:00Z");
const at = (iso: string, locale: string, style: "short" | "stamp" | "date" = "short", timeZone = "UTC") => formatTime(iso, { now, timeZone, locale, style });

it("shows only the clock time for today", () => {
  expect(at("2026-10-24T09:30:00Z", "en").text).toBe("9:30 AM");
  expect(at("2026-10-24T09:30:00Z", "ja").text).toBe("9:30");
});

it("names yesterday and does not repeat the time", () => {
  expect(at("2026-10-23T23:59:00Z", "en").text).toBe("Yesterday");
  expect(at("2026-10-23T23:59:00Z", "ja").text).toBe("昨日");
});

it("shows the month and day for this year and the full date for an earlier year", () => {
  expect(at("2026-03-04T09:30:00Z", "en").text).toBe("Mar 4");
  expect(at("2026-03-04T09:30:00Z", "ja").text).toBe("3月4日");
  expect(at("2025-03-04T09:30:00Z", "en").text).toBe("Mar 4, 2025");
  expect(at("2025-03-04T09:30:00Z", "ja").text).toBe("2025年3月4日");
});

it("puts the time after the date on the line of a post", () => {
  expect(at("2026-10-16T11:37:00Z", "en", "stamp").text).toBe("Oct 16 11:37 AM");
  expect(at("2025-10-16T11:37:00Z", "en", "stamp").text).toBe("Oct 16, 2025 11:37 AM");
});

it("counts days on the calendar of the reader's time zone", () => {
  // 23:30 UTC on the 23rd is already the 24th in Tokyo: today there, yesterday in UTC.
  expect(at("2026-10-23T23:30:00Z", "en", "short", "UTC").text).toBe("Yesterday");
  expect(at("2026-10-23T23:30:00Z", "en", "short", "Asia/Tokyo").text).toBe("8:30 AM");
});

it("gives a readable full date for the title, never the machine string", () => {
  const full = at("2026-10-16T11:37:00Z", "en").full;
  expect(full).toContain("October 16, 2026");
  expect(full).not.toContain("T11:37");
});

it("shows calendar dates through the day while retaining the clock in the title", () => {
  const iso = "2026-10-23T23:30:00Z";
  const utc = at(iso, "en", "date");
  const tokyo = at(iso, "ja", "date", "Asia/Tokyo");
  expect(utc).toMatchObject({ text: "October 23, 2026", showsTime: false });
  expect(tokyo).toMatchObject({ text: "2026年10月24日", showsTime: false });
  expect(tokyo.full).toContain("8:30");
  expect(at("2025-03-04T09:30:00Z", "ja", "date").text).toBe("2025年3月4日");
});
