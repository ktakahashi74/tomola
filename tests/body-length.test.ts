import { describe, expect, it } from "vitest";
import { bodyLength, bodyWithinLimits, MAX_BODY_BYTES, topicBodyLength } from "~/lib/body-length";

describe("body length", () => {
  it.each([
    ["ABC", 3], ["かな漢字", 8], ["한글", 4], ["Ａ１", 4], ["ｶﾅ", 2],
    ["e\u0301", 1], ["か\u3099", 2], ["한", 2], ["😀", 2],
    ["👩‍💻", 5], ["𠀀", 2], ["\uD800", 1], ["\uDC00", 1], ["𝄞", 1],
    ["\u00A1", 1], ["\u{1FAEA}", 2],
  ])("counts %j after NFC using fixed Unicode width data", (text, length) => {
    expect(topicBodyLength(text)).toBe(length);
    expect(topicBodyLength(text.normalize("NFC"))).toBe(length);
  });

  it("accepts exactly the topic limit in both scripts", () => {
    for (const text of ["a".repeat(100_000), "あ".repeat(50_000)]) {
      expect(bodyWithinLimits(text, "topic")).toBe(true);
      expect(bodyWithinLimits(text + "a", "topic")).toBe(false);
    }
    expect(bodyWithinLimits("あ".repeat(50_001), "topic")).toBe(false);
  });

  it("keeps UTF-16 counting for replies", () => {
    expect(bodyLength("e\u0301😀", "reply")).toBe(4);
    for (const text of ["a", "あ", "\uD800"]) {
      expect(bodyWithinLimits(text.repeat(50_000), "reply")).toBe(true);
      expect(bodyWithinLimits(text.repeat(50_001), "reply")).toBe(false);
    }
    expect(bodyWithinLimits("😀".repeat(25_000), "reply")).toBe(true);
    expect(bodyWithinLimits("😀".repeat(25_001), "reply")).toBe(false);
  });

  it("applies the UTF-8 byte bound independently of the weighted count", () => {
    // These neutral supplementary characters are four bytes but one unit each.
    const exact = "𝄞".repeat(MAX_BODY_BYTES / 4);
    expect(topicBodyLength(exact)).toBe(65_536);
    expect(bodyWithinLimits(exact, "topic")).toBe(true);
    expect(bodyWithinLimits(exact + "a", "topic")).toBe(false);
    expect(bodyWithinLimits("😀".repeat(50_000), "topic")).toBe(true);
    expect(bodyWithinLimits("😀".repeat(65_537), "topic")).toBe(false);
  });
});
