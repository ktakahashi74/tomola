import { describe, expect, it } from "vitest";
import { segmentId, segmentSentences } from "~/lib/segment";

const texts = (s: string, lang: string) => segmentSentences(s, lang).map((p) => p.text);

describe("segmentSentences", () => {
  it("splits Japanese at 。！？ and at line breaks, with positions into the original text", () => {
    const body = "これは最初の文です。これは二番目です！　三番目？\n\n次の段落。\n- 箇条書き\n- もう一つ";
    expect(texts(body, "ja")).toEqual([
      "これは最初の文です。",
      "これは二番目です！",
      "三番目？",
      "次の段落。",
      "- 箇条書き",
      "- もう一つ",
    ]);
    for (const p of segmentSentences(body, "ja")) expect(body.slice(p.start, p.end)).toBe(p.text);
    expect(segmentSentences(body, "ja").map((p) => p.idx)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("splits English at sentence ends without breaking after abbreviations", () => {
    const body = "Hello world. This is Dr. Smith. See U.S. policy! Really?\nNext line without a period\n\nPara two.";
    const parts = texts(body, "en");
    expect(parts[0]).toBe("Hello world.");
    expect(parts).toContain("Really?");
    expect(parts).toContain("Next line without a period");
    expect(parts.at(-1)).toBe("Para two.");
    // No sentence crosses a paragraph boundary.
    for (const p of segmentSentences(body, "en")) expect(body.slice(p.start, p.end)).not.toMatch(/\n/);
  });

  it("splits Thai at punctuation, and keeps the ICU result for a line that has any", () => {
    // Lines with punctuation retain ICU segmentation; do not split them at internal whitespace.
    const body = "วันนี้อากาศดีมาก. เราไปเดินเล่น ที่สวนสาธารณะ\n\nThis is english. ประโยคสุดท้าย";
    expect(texts(body, "th")).toEqual(["วันนี้อากาศดีมาก.", "เราไปเดินเล่น ที่สวนสาธารณะ", "This is english.", "ประโยคสุดท้าย"]);
    expect(texts("ผมชื่อสมชาย ยินดีที่ได้รู้จัก.", "th")).toEqual(["ผมชื่อสมชาย ยินดีที่ได้รู้จัก."]);
    expect(texts("คุณชอบไหม? ผมชอบ ๆ", "th")).toEqual(["คุณชอบไหม?", "ผมชอบ ๆ"]);
  });

  it("splits a Thai line without sentence punctuation at spaces (Thai separates sentences and clauses with spaces)", () => {
    const body = "สวัสดีครับ ผมชื่อสมชาย ยินดีที่ได้รู้จัก\n\nวันนี้ผมอยากถามเรื่องความปลอดภัยของระบบปัญญาประดิษฐ์   ทุกคนคิดอย่างไร\tครับ";
    expect(texts(body, "th")).toEqual([
      "สวัสดีครับ",
      "ผมชื่อสมชาย",
      "ยินดีที่ได้รู้จัก",
      "วันนี้ผมอยากถามเรื่องความปลอดภัยของระบบปัญญาประดิษฐ์",
      "ทุกคนคิดอย่างไร",
      "ครับ",
    ]);
    // Offsets refer to the original string, including repeated spaces and tabs; idx is sequential.
    const parts = segmentSentences(body, "th");
    for (const p of parts) expect(body.slice(p.start, p.end)).toBe(p.text);
    expect(parts.map((p) => p.idx)).toEqual([0, 1, 2, 3, 4, 5]);
    // Full-width spaces, CRLF, and leading/trailing whitespace.
    expect(texts("  สวัสดี\u3000ครับ \r\nขอบคุณ ค่ะ  ", "th")).toEqual(["สวัสดี", "ครับ", "ขอบคุณ", "ค่ะ"]);
  });

  it("does not take a URL's dot, a list marker or a heading mark as a sentence of its own in Thai", () => {
    // A dot in a URL is not a sentence ending; treat the line as whitespace-delimited.
    expect(texts("ดูรายละเอียดที่ https://example.com/a.b ได้เลย", "th")).toEqual(["ดูรายละเอียดที่", "https://example.com/a.b", "ได้เลย"]);
    expect(texts("- รายการ หนึ่ง\n* รายการ สอง\n# หัวข้อ ใหญ่\n> คำพูด ที่อ้าง", "th")).toEqual([
      "- รายการ",
      "หนึ่ง",
      "* รายการ",
      "สอง",
      "# หัวข้อ",
      "ใหญ่",
      "> คำพูด",
      "ที่อ้าง",
    ]);
    // A line containing only symbols is one sentence.
    expect(texts("---\n- -", "th")).toEqual(["---", "- -"]);
    // A one-word line stays unchanged.
    expect(texts("ขอบคุณ", "th")).toEqual(["ขอบคุณ"]);
  });

  it("changes nothing for other languages: a line without punctuation stays one sentence", () => {
    expect(texts("one two three four", "en")).toEqual(["one two three four"]);
    expect(texts("これは 空白のある 文", "ja")).toEqual(["これは 空白のある 文"]);
    expect(texts("안녕하세요 반갑습니다 여러분", "ko")).toEqual(["안녕하세요 반갑습니다 여러분"]);
    expect(texts("Xin chào các bạn rất vui được gặp", "vi")).toEqual(["Xin chào các bạn rất vui được gặp"]);
  });

  it("gives the same result for the same input, ignores blank runs, and keeps indices contiguous", () => {
    const body = "  \n\n  一つ目。\r\n\r\n\r\n二つ目。  \n";
    const a = segmentSentences(body, "ja");
    expect(a).toEqual(segmentSentences(body, "ja"));
    expect(a.map((p) => [p.idx, p.text])).toEqual([
      [0, "一つ目。"],
      [1, "二つ目。"],
    ]);
    expect(segmentSentences("", "en")).toEqual([]);
    expect(segmentSentences("  \n \n", "en")).toEqual([]);
  });

  it("counts positions in UTF-16 code units (astral characters and combining marks)", () => {
    const body = "😀 first. second 🎉.";
    for (const p of segmentSentences(body, "en")) expect(body.slice(p.start, p.end)).toBe(p.text);
  });

  it("does not throw for an unknown language tag and builds sentence ids", () => {
    expect(texts("One. Two.", "not a tag")).toEqual(["One.", "Two."]);
    expect(segmentId(3)).toBe("s-3");
    expect(texts("一文。二文。", "zh-Hant")).toEqual(["一文。", "二文。"]);
  });
});
