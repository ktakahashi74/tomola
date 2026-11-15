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

it.each(["public-reply", "chat"] as const)("checks named handles against material authors in %s readings", destination => {
  const supplied = { ...materials, sources: [
    { ...materials.sources[0], author: "@writer" },
    { ...materials.sources[0], id: "e-2-body", author: "@another_writer" },
  ] };
  for (const text of ["@writer asks for review.", "@Writer asks for review.", "＠writer asks for review.", "@ｗｒｉｔｅｒ asks for review.", "＠Ｗｒｉｔｅｒ asks for review.", "@another_writer disagrees with @writer.", "投稿では@writerが検討を求める。", "Email reader@example.org for context."]) {
    expect(verifyNushiAnswerResult(answer([{ ...reading, text }]), supplied, destination)).toMatchObject({ ok: true });
  }
  for (const text of ["@outsider asks for review.", "＠Ｏｕｔｓｉｄｅｒ asks for review.", "@writer_suffix asks for review."]) {
    const raw = answer([{ ...reading, text }]);
    expect(verifyNushiAnswerResult(raw, supplied, destination)).toEqual({ ok: false, reason: "unknown_author", counts: { readings: 1, citations: 1 } });
    expect(verifyNushiAnswer(raw, supplied, destination)).toBeNull();
    expect(verifyQuestionAnswerResult(raw, supplied)).toMatchObject({ ok: true });
  }
});

it.each(["public-reply", "chat"] as const)("normalizes supplied author fields as well as named handles in %s readings", destination => {
  const supplied = { ...materials, sources: [{ ...materials.sources[0], author: "＠Ｗｒｉｔｅｒ" }] };
  expect(verifyNushiAnswerResult(answer([{ ...reading, text: "@writer asks for review." }]), supplied, destination)).toMatchObject({ ok: true });
  expect(verifyNushiAnswerResult(answer([{ ...reading, text: "＠ＷＲＩＴＥＲ asks for review." }]), supplied, destination)).toMatchObject({ ok: true });
});

it.each(["public-reply", "chat"] as const)("reserves handles for material authors while allowing other names and terms without a sigil in %s", destination => {
  const original = "@carol: Please review @property and @media before @10am.";
  const supplied = { ...materials, sources: [{ ...materials.sources[0], author: "@writer", original, translation: undefined }] };
  const citations = [{ sourceId: "e-1-body", quote: original }];
  const text = "@writer asks carol to review property and media before 10am, following a question about previous_reader.";
  expect(verifyNushiAnswerResult(answer([{ text, citations }]), supplied, destination)).toMatchObject({ ok: true });
  for (const name of ["carol", "property", "media", "10am", "previous_reader"]) {
    expect(verifyNushiAnswerResult(answer([{ text: text.replace(name, `@${name}`), citations }]), supplied, destination)).toMatchObject({ ok: false, reason: "unknown_author" });
  }
});

it("does not treat departed labels or names inside source prose as named authors", () => {
  for (const author of ["Departed member", "退会した会員"]) {
    const supplied = { ...materials, sources: [{ ...materials.sources[0], author, original: "@outsider requests public review.", translation: undefined }] };
    const citations = [{ sourceId: "e-1-body", quote: supplied.sources[0].original }];
    expect(verifyNushiAnswerResult(answer([{ text: `${author} requests public review.`, citations }]), supplied)).toMatchObject({ ok: true });
    expect(verifyNushiAnswerResult(answer([{ text: "@outsider requests public review.", citations }]), supplied)).toMatchObject({ ok: false, reason: "unknown_author" });
    expect(verifyNushiAnswerResult(answer([{ text: "@Departed requests public review.", citations }]), supplied)).toMatchObject({ ok: false, reason: "unknown_author" });
  }
});

it("rejects an unknown handle after a maximum-length author spelling", () => {
  const author = "@" + "a".repeat(30), supplied = { ...materials, sources: [{ ...materials.sources[0], author }] };
  expect(verifyNushiAnswerResult(answer([{ ...reading, text: `${author} asks for review.` }]), supplied)).toMatchObject({ ok: true });
  expect(verifyNushiAnswerResult(answer([{ ...reading, text: `${author}b asks for review.` }]), supplied)).toMatchObject({ ok: false, reason: "unknown_author" });
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
