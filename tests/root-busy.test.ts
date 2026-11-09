import { expect, it, vi } from "vitest";
import { MarkdownBusyError } from "~/lib/markdown-budget.server";
import { m } from "~/paraglide/messages.js";

vi.mock("~/lib/markdown-startup.server", () => ({ initializeSiteMarkdown: async () => {} }));
vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));

it("explains a busy Markdown response to clients and retains the retry delay", async () => {
  const { middleware } = await import("~/root");
  const response: unknown = await Promise.resolve(middleware[2]({ request: new Request("https://example.com/t/1.md") } as never, (async () => { throw new MarkdownBusyError(); }) as never)).catch((error: unknown) => error);
  expect(response).toBeInstanceOf(Response);
  if (!(response instanceof Response)) throw response;
  expect(response.status).toBe(503);
  expect(response.headers.get("Retry-After")).toBe("1");
  expect(await response.json()).toMatchObject({ error: expect.any(String), message: m.error_unavailable(), retryAfter: "1" });
});
