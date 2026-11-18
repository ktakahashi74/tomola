import { afterEach, expect, it, vi } from "vitest";
import { claudeComplete, createClaudeEngine, type ClaudeClient, type ClaudeMessage } from "~/lib/llm/engines/claude.server";

afterEach(() => vi.restoreAllMocks());
const response: ClaudeMessage = { content: [{ type: "text", text: "Translated.", citations: null }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: null, cache_read_input_tokens: null, cache_creation: null, inference_geo: null, server_tool_use: null, service_tier: null, output_tokens_details: null, speed: null } };

it.each([10, 10_000, 100_000])("uses matching HTTP and abort deadlines for a queued %i-character translation", async length => {
  const deadline = vi.spyOn(AbortSignal, "timeout");
  const create = vi.fn<ClaudeClient["messages"]["create"]>().mockResolvedValue(response);
  await createClaudeEngine({ client: { messages: { create } } }).translate({ text: "a".repeat(length), from: "en", to: "ja", postTranslation: true });
  const expected = length === 10 ? 120_000 : length === 10_000 ? 410_400 : 900_000;
  expect(deadline).toHaveBeenCalledWith(expected);
  expect(create.mock.calls[0][1]).toMatchObject({ timeout: expected, maxRetries: 0, signal: expect.any(AbortSignal) });
});

it.each(["title", "body"] as const)("keeps a direct interactive %s translation at two minutes", async field => {
  const deadline = vi.spyOn(AbortSignal, "timeout");
  const create = vi.fn<ClaudeClient["messages"]["create"]>().mockResolvedValue(response);
  await createClaudeEngine({ client: { messages: { create } } }).translate({ text: "a".repeat(100_000), from: "en", to: "ja", field });
  expect(deadline).toHaveBeenCalledWith(120_000);
  expect(create.mock.calls[0][1]?.timeout).toBe(120_000);
});

it("keeps ordinary completions at two minutes with a large output cap", async () => {
  const create = vi.fn<ClaudeClient["messages"]["create"]>().mockResolvedValue(response);
  await claudeComplete({ messages: { create } }, { model: "fixture", system: "", user: "", maxTokens: 64_000 });
  expect(create.mock.calls[0][1]?.timeout).toBe(120_000);
});

it("retains job cancellation during an extended deadline", async () => {
  const abort = new AbortController();
  const create = vi.fn<ClaudeClient["messages"]["create"]>().mockImplementation(async (_body, options) => {
    abort.abort(new Error("job stopped"));
    options!.signal!.throwIfAborted();
    return response;
  });
  await expect(createClaudeEngine({ client: { messages: { create } } }).translate({ text: "a".repeat(100_000), from: "en", to: "ja", postTranslation: true, signal: abort.signal })).rejects.toThrow("job stopped");
});
