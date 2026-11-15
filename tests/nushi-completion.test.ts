import { afterEach, expect, it, vi } from "vitest";
import { completeNushiAnswer } from "~/lib/nushi-completion.server";
import { AI_QUESTION_LIMITS as limits } from "~/lib/ai-questions";
import type { AiQuestionMaterials } from "~/lib/ai-question-materials.server";
import type { CompleteRequest } from "~/lib/llm/completion.server";
import { llmUsage } from "~/lib/db/schema";
import { BudgetPausedError } from "~/lib/llm/errors.server";
import { createTestDb } from "./helpers/db";

afterEach(() => vi.restoreAllMocks());
const materials: AiQuestionMaterials = { sources: Array.from({ length: 10 }, (_, i) => ({ id: `e-${i + 1}-body`, kind: "post", field: "body", author: "@writer", lang: "en", sourceHash: "hash", href: `/t/${i + 1}`, original: `Passage ${i + 1}. ` + "x".repeat(700) })), scope: { sources: 10, replies: 0, truncated: false } };
const cite = (index: number) => ({ sourceId: materials.sources[index - 1].id, quote: `Passage ${index}.` });
const reading = (indices = [1], text = "The supplied posts discuss an orchard.") => ({ text, citations: indices.map(cite) });
const raw = (readings = [reading()], extra = {}) => JSON.stringify({ status: "answered", readings, ...extra });
const nine = raw([reading([1, 2, 3, 4, 5]), reading([6, 7, 8, 9])]);
const prompt = { system: "Use only supplied evidence.", user: "SAME_MATERIALS", maxOutputTokens: limits.outputTokens };

async function run(outputs: string[], destination: "public-reply" | "chat" = "public-reply") {
  const db = await createTestDb();
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const complete = vi.fn(async (_req: CompleteRequest) => ({ text: outputs[Math.min(complete.mock.calls.length - 1, outputs.length - 1)], inputTokens: 1000, outputTokens: 200 }));
  const result = await completeNushiAnswer(db, { engine: "gemini", model: "gemini-3.5-flash-lite", complete }, prompt, materials, { destination, clock: () => new Date(), env: {} });
  return { result, complete, usage: await db.select().from(llmUsage), info };
}

it.each(["public-reply", "chat"] as const)("regenerates once for nine citations and meters both %s calls", async destination => {
  const r = await run([nine, raw([reading([1, 2]), reading([3])])], destination);
  expect(r.result).toMatchObject({ ok: true, truncated: false });
  expect(r.complete).toHaveBeenCalledTimes(2);
  const retry = r.complete.mock.calls[1][0];
  expect(retry.user).toBe(prompt.user);
  expect(retry.system).toContain(prompt.system);
  expect(retry.system).toMatch(/citations_count: 9, limit 8/);
  expect(retry.system).not.toContain("Passage");
  expect(r.usage).toHaveLength(2);
  for (const row of r.usage) expect(row).toMatchObject({ purpose: "ask_village", reserved: false, inputTokens: 1000, outputTokens: 200, costUsdMicro: expect.any(Number) });
  expect(r.usage.every(row => row.costUsdMicro > 0)).toBe(true);
  expect(JSON.stringify(r.info.mock.calls)).not.toMatch(/Passage|orchard|SAME_MATERIALS/);
});

it("retains the first readings and citations in order, drops unsupported readings, and marks the scope", async () => {
  const oversized = raw([reading([1, 2, 3, 4, 5, 6], "First"), reading([7, 8, 9], "Second"), reading([10], "Third"), reading([2, 10], "Fourth"), reading([1], "Fifth")]);
  const r = await run([oversized, oversized]);
  expect(r.complete).toHaveBeenCalledTimes(2);
  expect(r.result).toMatchObject({ ok: true, truncated: true, answer: { readings: [
    { text: "First", citations: [1, 2, 3, 4, 5, 6] }, { text: "Second", citations: [7, 8] }, { text: "Fourth", citations: [2] },
  ] } });
  if (!r.result.ok) throw new Error("Expected verified output");
  expect(r.result.answer.citations.map(c => c.sourceId)).toEqual(Array.from({ length: 8 }, (_, i) => `e-${i + 1}-body`));
  expect(r.info.mock.calls.map(call => call[0])).toEqual(["Nushi answer regeneration", "Nushi answer bounded"]);
});

it.each([
  ["readings_count", raw(Array.from({ length: 5 }, () => reading()))],
  ["reading_too_long", raw([reading([1], "x".repeat(limits.readingChars + 1))])],
  ["quote_too_long", raw([{ ...reading(), citations: [{ sourceId: "e-1-body", quote: "x".repeat(limits.quoteChars + 1) }] }])],
  ["output_too_long", raw() + " ".repeat(limits.outputChars)],
])("regenerates a valid answer after %s", async (reason, oversized) => {
  const r = await run([oversized, raw()]);
  expect(r.result).toMatchObject({ ok: true, truncated: false });
  expect(r.complete).toHaveBeenCalledTimes(2);
  expect(r.complete.mock.calls[1][0].system).toContain(reason);
});

it.each([
  ["reading_too_long", raw([reading([1], "x".repeat(limits.readingChars + 1))])],
  ["quote_too_long", raw([{ ...reading(), citations: [{ sourceId: "e-1-body", quote: "x".repeat(limits.quoteChars + 1) }] }])],
  ["output_too_long", raw() + " ".repeat(limits.outputChars)],
])("does not trim or regenerate again after a persistent %s", async (reason, oversized) => {
  const r = await run([oversized, oversized]);
  expect(r.result).toMatchObject({ ok: false, reason, truncated: false });
  expect(r.complete).toHaveBeenCalledTimes(2);
});

it.each([
  ["quote_not_found", raw([{ ...reading(), citations: [{ ...cite(1), quote: "INVENTED" }] }])],
  ["unknown_source", raw([{ ...reading(), citations: [{ ...cite(1), sourceId: "unknown" }] }])],
  ["extra_field", raw([reading()], { extra: "INVENTED" })],
  ["extra_field", raw(Array.from({ length: 5 }, () => reading()), { extra: "INVENTED" })],
  ["quote_not_found", raw([reading([1, 2, 3, 4, 5]), { ...reading([6, 7, 8, 9]), citations: [cite(6), cite(7), cite(8), { ...cite(9), quote: "INVENTED" }] }])],
  ["readings_count", raw([])],
  ["citations_count", raw([{ ...reading(), citations: [] }])],
])("does not regenerate content or missing-evidence failures (%s) %#", async (reason, invalid) => {
  const r = await run([invalid, raw()]);
  expect(r.result).toMatchObject({ ok: false, reason, truncated: false });
  expect(r.complete).toHaveBeenCalledTimes(1);
});

it("checks quotations retained after the second response and refuses content errors", async () => {
  const invalid = raw([reading([1, 2, 3, 4, 5]), { text: "Second", citations: [cite(6), { ...cite(7), quote: "INVENTED" }, cite(8), cite(9)] }]);
  const r = await run([nine, invalid]);
  expect(r.result).toMatchObject({ ok: false, reason: "quote_not_found", truncated: false });
  expect(r.complete).toHaveBeenCalledTimes(2);
});

it("checks the budget again before the regeneration call", async () => {
  const db = await createTestDb(), env = { VILLAGE_NUSHI_LLM_MONTHLY_BUDGET_USD: "10" };
  vi.spyOn(console, "info").mockImplementation(() => {});
  const complete = vi.fn(async () => { env.VILLAGE_NUSHI_LLM_MONTHLY_BUDGET_USD = "0"; return { text: nine, inputTokens: 1000, outputTokens: 200 }; });
  await expect(completeNushiAnswer(db, { engine: "gemini", model: "gemini-3.5-flash-lite", complete }, prompt, materials, { clock: () => new Date(), env })).rejects.toBeInstanceOf(BudgetPausedError);
  expect(complete).toHaveBeenCalledTimes(1);
  expect(await db.select().from(llmUsage)).toHaveLength(1);
});

it.each(["public-reply", "chat"] as const)("accepts fenced JSON through both %s size checks", async destination => {
  const r = await run(["```json\n" + nine + "\n```", "```\n" + raw() + "\n```"], destination);
  expect(r.result).toMatchObject({ ok: true, truncated: false });
  expect(r.complete).toHaveBeenCalledTimes(2);
});
