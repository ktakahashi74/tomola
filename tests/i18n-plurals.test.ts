import { expect, it } from "vitest";
import { checkMessages, validateMessage } from "~/lib/i18n/messages";
import { fingerprint } from "~/lib/i18n/source-hashes";
import { m } from "../app/paraglide/messages.js";

const plural = [{ declarations: ["input count", "local countPlural = count: plural"], selectors: ["countPlural"], match: { "countPlural=one": "{count} item", "countPlural=other": "{count} items" } }];
it("validates and fingerprints plural variants and permits invariant Japanese", () => {
  expect(checkMessages({ en: { items: plural }, ja: { items: "{count}件" } })).toEqual([]);
  expect(validateMessage(plural, [{ ...plural[0], match: { "countPlural=other": "items" } }], { locale: "en" }).length).toBeGreaterThan(0);
  expect(fingerprint(plural)).not.toBe(fingerprint([{ ...plural[0], match: { ...plural[0].match, "countPlural=one": "{count} thing" } }]));
});
it("uses cardinal plurals for zero, one and multiple counts", () => {
  expect(m.nav_notifications_unread({ count: 0 }, { locale: "en" })).toBe("0 unread notifications");
  expect(m.nav_notifications_unread({ count: 1 }, { locale: "en" })).toBe("1 unread notification");
  expect(m.nav_notifications_unread({ count: 2 }, { locale: "en" })).toBe("2 unread notifications");
  expect(m.nav_notifications_unread({ count: 1 }, { locale: "ja" })).toContain("1");
});
