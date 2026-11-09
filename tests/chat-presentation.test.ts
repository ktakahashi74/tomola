import { expect, it, vi } from "vitest";
import { chatClock, chatDay, chatDayLabel, groupChatMessage } from "~/lib/chat-calendar";
import { groupChatNotifications } from "~/lib/group-chat-notifications";
import type { ActiveChatMessage } from "~/lib/village-chat";

it("reuses date formatters across repeated messages in the same locale and timezone", () => {
  const Original = Intl.DateTimeFormat;
  const spy = vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (...args: ConstructorParameters<typeof Intl.DateTimeFormat>) { return new Original(...args); });
  try {
    const calendar = { timeZone: "Pacific/Honolulu", locale: "fr", now: Date.parse("2026-10-17T12:00:00Z") };
    for (let i = 0; i < 100; i++) {
      const iso = new Date(Date.UTC(2026, 9, 15, 0, i)).toISOString();
      chatDay(iso, calendar); chatClock(iso, calendar); chatDayLabel(iso, calendar, "today", "yesterday");
    }
    expect(spy).toHaveBeenCalledTimes(4);
  } finally { spy.mockRestore(); }
});

it("uses calendar days in the viewer's timezone across midnight and daylight-saving changes", () => {
  const utc = { timeZone: "UTC", locale: "en", now: Date.parse("2026-10-16T01:00:00Z") };
  const tokyo = { ...utc, timeZone: "Asia/Tokyo" };
  expect(chatDay("2026-10-15T23:30:00Z", utc)).toBe("2026-10-15");
  expect(chatDay("2026-10-15T23:30:00Z", tokyo)).toBe("2026-10-16");
  expect(chatClock("2026-10-15T23:30:00Z", tokyo).time).toBe("08:30");
  expect(chatClock("2026-10-15T23:30:00Z", utc).time).toBe("23:30 UTC");
  expect(chatDayLabel("2026-10-15T23:30:00Z", tokyo, "today", "yesterday")).toBe("today");
  expect(chatDayLabel("2026-10-14T23:30:00Z", tokyo, "today", "yesterday")).toBe("yesterday");
  const dst = { timeZone: "America/New_York", locale: "en", now: Date.parse("2026-03-09T04:30:00Z") };
  expect(chatDayLabel("2026-03-08T05:30:00Z", dst, "today", "yesterday")).toBe("yesterday");
  expect(chatDayLabel("2025-10-14T12:00:00Z", utc, "today", "yesterday")).toContain("2025");
});

it("groups only neighboring messages by the same author within five minutes and the same local day", () => {
  const calendar = { timeZone: "Asia/Tokyo", locale: "en", now: 0 };
  const message = { author: "reader", createdAt: "2026-10-16T14:59:00Z", hidden: false } as ActiveChatMessage;
  expect(groupChatMessage(message, { ...message, createdAt: "2026-10-16T14:59:30Z" }, calendar)).toBe(true);
  expect(groupChatMessage(message, { ...message, createdAt: "2026-10-16T15:00:00Z" }, calendar)).toBe(false);
  expect(groupChatMessage(message, { ...message, author: "other" }, calendar)).toBe(false);
  expect(groupChatMessage(message, { ...message, createdAt: "2026-10-16T15:05:00Z" }, calendar)).toBe(false);
  expect(groupChatMessage({ ...message, hidden: true }, message, calendar)).toBe(false);
});

it("groups consecutive chat notices while preserving separate villages, read states and intervening notices", () => {
  const mention = (id: number, slug = "one", read = false) => ({ id, chat: { slug }, read, kind: "chat_mention", actorHandle: `author${id}` });
  const groups = groupChatNotifications([mention(8), mention(7), mention(6, "two"), { ...mention(5), kind: "mention" }, mention(4), mention(3, "one", true), mention(2, "one", true)]);
  expect(groups.map(group => group.id)).toEqual([7, 6, 5, 4, 2]);
  expect(groups[0]).toMatchObject({ chatCount: 2, chatHandles: ["author8", "author7"] });
  expect(groups.at(-1)).toMatchObject({ chatCount: 2, read: true });
});


it("renders the initial calendar from ISO strings without consulting the server or browser ICU", () => {
  const intl = vi.spyOn(Intl, "DateTimeFormat").mockImplementation(() => { throw new Error("No ICU before hydration"); });
  try {
    const initial = { timeZone: null, locale: "en", now: Date.parse("2026-10-16T01:00:00Z") };
    expect(chatDay("2026-10-15T23:30:00Z", initial)).toBe("2026-10-15");
    expect(chatClock("2026-10-15T23:30:00Z", initial)).toEqual({ time: "23:30 UTC", full: "2026-10-15 23:30 UTC" });
    expect(chatDayLabel("2026-10-15T23:30:00Z", initial, "today", "yesterday")).toBe("yesterday");
    expect(chatDayLabel("2025-10-14T23:30:00Z", initial, "today", "yesterday")).toBe("2025-10-14");
    expect(intl).not.toHaveBeenCalled();
  } finally { intl.mockRestore(); }
});

it("does not invent a mention handle for an unavailable author", () => {
  const notice = { id: 1, kind: "chat_mention", read: false, actorHandle: null, chat: { slug: "one" } };
  expect(groupChatNotifications([notice])[0].chatHandles).toEqual([]);
  for (const items of [[notice, { ...notice, id: 2, actorHandle: "writer" }], [{ ...notice, id: 2, actorHandle: "writer" }, notice]]) {
    expect(groupChatNotifications(items)[0]).toMatchObject({ chatHandles: [], chatCount: 2 });
    expect(groupChatNotifications([...items, { ...notice, id: 3, actorHandle: "another" }])[0].chatHandles).toEqual([]);
  }
});
