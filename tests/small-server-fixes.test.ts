import { afterEach, expect, it, vi } from "vitest";
import type { Db } from "~/lib/db/client.server";
import { loadConsentRequest } from "~/lib/mcp/consent.server";
import type { McpAuth } from "~/lib/mcp/auth.server";
import { createGeminiEmbeddingEngine } from "~/lib/llm/engines/gemini-embedding.server";
import { transientFailureMessage } from "~/lib/jobs/transient-failure.server";
import { createNotificationHandlers } from "~/lib/jobs/notification-jobs.server";
import { enqueue, runDueJobs } from "~/lib/jobs/queue.server";
import { jobs } from "~/lib/db/schema";
import { createTestDb } from "./helpers/db";
import { MarkdownBusyError } from "~/lib/markdown-budget.server";
vi.mock("@better-auth/oauth-provider", () => ({ verifyOAuthQueryParams: async () => true }));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
it.each([undefined, "not a URL"])("rejects a missing or malformed consent redirect with 400 (%s)", async redirect => {
  const db = { select: () => ({ from: () => ({ where: async () => [{ clientId: "fixture", redirectUris: [] }] }) }) } as unknown as Db;
  const auth = { $context: Promise.resolve({ secret: "fixture" }) } as unknown as McpAuth;
  const query = new URLSearchParams({ client_id: "fixture", ...(redirect ? { redirect_uri: redirect } : {}) });
  await expect(loadConsentRequest(db, auth, query.toString())).rejects.toMatchObject({ init: { status: 400 } });
});
it("rejects cross-origin reply edits before authentication or body parsing", async () => {
  const { action } = await import("~/routes/reply-edit");
  const request = new Request("https://forum.example.org/c/1/edit", { method: "POST", headers: { Origin: "https://other.example.org" }, body: "invalid form" });
  await expect(action({ request, params: { id: "1" } } as Parameters<typeof action>[0])).rejects.toMatchObject({ init: { status: 403 } });
});
it.each(["query", "document"] as const)("bounds %s embeddings independently", async task => {
  const embedContent = vi.fn(async (_request: import("@google/genai").EmbedContentParameters) => ({ embeddings: [{ values: Array(768).fill(1) }] }));
  const engine = createGeminiEmbeddingEngine({ client: { models: { embedContent } } });
  await engine.embed({ text: "fixture", task });
  expect(embedContent.mock.calls[0][0].config?.httpOptions?.timeout).toBe(task === "query" ? 15_000 : 120_000);
});
it("records actual exhausted formatting contention for daily outage recovery", async () => {
  const db = await createTestDb();
  await enqueue(db, "translate_entry", {}, { maxAttempts: 1 });
  await runDueJobs(db, { translate_entry: async () => { throw new MarkdownBusyError(); } }, { now: new Date(Date.now() + 1000), logger: { warn() {}, error() {} } });
  expect(transientFailureMessage((await db.select().from(jobs))[0].lastError!)).toBe(true);
  expect(transientFailureMessage("LlmError: invalid_output")).toBe(false);
});
it("permanently fails an invalid per-member digest payload", async () => {
  const db = await createTestDb();
  await enqueue(db, "send_member_digest", { date: "not a date" });
  const result = await runDueJobs(db, createNotificationHandlers(), { limit: 1, logger: { warn() {}, error() {} } });
  expect(result).toMatchObject({ failed: 1, retried: 0 });
  expect((await db.select().from(jobs))[0]).toMatchObject({ status: "failed", attempts: 1 });
});
