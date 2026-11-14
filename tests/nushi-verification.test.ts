import { expect, it } from "vitest";
import { verifyQuestionAnswerResult, type AnswerVerificationReason } from "~/lib/ai-question-answer.server";
import { verifyNushiAnswer, verifyNushiAnswerResult } from "~/lib/nushi-answer.server";
import { AI_QUESTION_LIMITS as limits } from "~/lib/ai-questions";
import type { AiQuestionMaterials } from "~/lib/ai-question-materials.server";

const materials: AiQuestionMaterials = {
  sources: [{ id: "e-1-body", kind: "post", field: "body", author: "writer", lang: "en", sourceHash: "hash", href: "/t/1", original: "An orchard needs public review. A second passage.", translation: { text: "果樹園には公開の検討が必要。", lang: "ja", stale: false } }],
  scope: { sources: 1, replies: 0, truncated: false },
};
const citation = { sourceId: "e-1-body", quote: "An orchard needs public review.", translatedQuote: "果樹園には公開の検討が必要。" };
const reading = { text: "The supplied post requests public review.", citations: [citation] };
const answer = (readings: unknown = [reading], extra = {}) => JSON.stringify({ status: "answered", readings, ...extra });

const invalid: Array<[AnswerVerificationReason, string]> = [
  ["not_json", "PRIVATE_PROVIDER_TEXT"],
  ["output_too_long", "x".repeat(limits.outputChars + 1)],
  ["schema", answer(null)],
  ["readings_count", answer([])],
  ["readings_count", answer(Array.from({ length: limits.readings + 1 }, () => reading))],
  ["citations_count", answer([{ ...reading, citations: [] }])],
  ["citations_count", answer([{ ...reading, citations: Array.from({ length: limits.citations + 1 }, () => citation) }])],
  ["reading_too_long", answer([{ ...reading, text: "x".repeat(limits.readingChars + 1) }])],
  ["quote_too_long", answer([{ ...reading, citations: [{ ...citation, quote: "x".repeat(limits.quoteChars + 1) }] }])],
  ["quote_too_long", answer([{ ...reading, citations: [{ ...citation, translatedQuote: "x".repeat(limits.quoteChars + 1) }] }])],
  ["extra_field", answer([reading], { PRIVATE_FIELD: "PRIVATE_VALUE" })],
  ["extra_field", answer([{ ...reading, citations: [{ ...citation, url: "https://example.org" }] }])],
  ["unstructured_quote", answer([{ ...reading, text: 'An invented "quotation".' }])],
  ["unknown_source", answer([{ ...reading, citations: [{ ...citation, sourceId: "unknown" }] }])],
  ["quote_not_found", answer([{ ...reading, citations: [{ ...citation, quote: "PRIVATE_INVENTED_QUOTE" }] }])],
  ["translated_quote_not_found", answer([{ ...reading, citations: [{ ...citation, translatedQuote: "PRIVATE_TRANSLATION" }] }])],
  ["translated_quote_not_found", answer([{ ...reading, citations: [{ sourceId: citation.sourceId, quote: citation.quote }] }])],
];

it.each(invalid)("returns only a %s category and numeric counts for invalid output %#", (reason, raw) => {
  for (const verify of [verifyQuestionAnswerResult, verifyNushiAnswerResult]) {
    const result = verify(raw, materials);
    expect(result).toMatchObject({ ok: false, reason, counts: { readings: expect.any(Number), citations: expect.any(Number) } });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|orchard|quotation|example/);
  }
  expect(verifyNushiAnswer(raw, materials)).toBeNull();
});

it("counts supplied readings and citation occurrences without copying their contents", () => {
  expect(verifyNushiAnswerResult(answer([reading, reading], { extra: "private" }), materials)).toEqual({ ok: false, reason: "extra_field", counts: { readings: 2, citations: 2 } });
});

it("rejects too many distinct citations across individually bounded readings", () => {
  const sources = Array.from({ length: limits.citations + 1 }, (_, i) => ({ ...materials.sources[0], id: `e-${i + 1}-body` }));
  const citations = sources.map(source => ({ ...citation, sourceId: source.id }));
  const raw = answer([{ ...reading, citations: citations.slice(0, 5) }, { ...reading, citations: citations.slice(5) }]);
  expect(verifyNushiAnswerResult(raw, { ...materials, sources })).toEqual({ ok: false, reason: "citations_count", counts: { readings: 2, citations: 9 } });
});

it("rejects translations that were not supplied and validates extracted control fields", () => {
  expect(verifyNushiAnswerResult(answer(), { ...materials, sources: [{ ...materials.sources[0], translation: undefined }] })).toMatchObject({ ok: false, reason: "unexpected_translation" });
  for (const field of ["askPerson", "clarificationNeeded"]) {
    expect(verifyNushiAnswerResult(answer([reading], { [field]: "PRIVATE_VALUE" }), materials, "chat")).toMatchObject({ ok: false, reason: "schema" });
  }
  expect(verifyNushiAnswerResult("[]", materials)).toMatchObject({ ok: false, reason: "schema" });
  expect(verifyNushiAnswerResult(JSON.stringify({ status: "not_confirmed", askPerson: true, clarificationNeeded: true }), materials, "chat")).toMatchObject({ ok: true, answer: { status: "not_confirmed", readings: [], askPerson: true }, clarificationNeeded: true });
  expect(verifyNushiAnswerResult(answer(), materials)).toMatchObject({ ok: true, answer: { status: "answered" } });
});
