import { requireScopes, type McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Db } from "~/lib/db/client.server";
import { MAX_TITLE_LENGTH } from "~/lib/entries.server";
import { SOURCE_LANGS } from "~/lib/languages";
import { DRAFT_RATE_LIMIT, hitRateLimit } from "~/lib/rate-limit.server";
import type { McpPrincipal } from "./auth.server";
import { MCP_CONTENT_WARNING as contentWarning, mcpText } from "./output.server";
import { discardEntryEdit, getClientEntryEdit, getClientEntryEditStatus, prepareEntryDeletion, prepareEntryEdit } from "./post-proposals.server";

type RunTool = (name: string, operation: () => Promise<ReturnType<typeof mcpText>>) => Promise<ReturnType<typeof mcpText>>;

export function registerPostWorkflowTools(server: McpServer, db: Db, principal: McpPrincipal, runDraft: RunTool, runDraftRead: RunTool) {
  const { userId, client, scopes } = principal;
  const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
  const failure = (message: string) => ({ ...mcpText(message, "error"), isError: true });
  const result = (record: unknown) => mcpText(JSON.stringify(record), "post_workflow");
  const both = requireScopes("read", "draft");
  const canRead = () => scopes.has("read");

  server.registerTool("tomola_entry_edit_prepare", {
    description: "Save a proposed title, body, or source language for your own published post or reply. Omitted fields stay as they are. The member reviews the change and applies it in the browser. Returns an approval URL and proposal version." + contentWarning,
    inputSchema: z.object({ entryId: id, title: z.string().max(MAX_TITLE_LENGTH).nullable().optional(), body: z.string().optional(), lang: z.enum(SOURCE_LANGS).optional() }),
    scopeChallenge: both, annotations: { destructiveHint: false, openWorldHint: false },
  }, async ({ entryId, ...change }) => runDraft("tomola_entry_edit_prepare", async () => {
    if (!canRead()) return failure("The read scope is required.");
    const rate = await hitRateLimit(db, { key: `draft:member:${userId}`, ...DRAFT_RATE_LIMIT });
    if (!rate.allowed) return failure("Draft creation rate limit reached.");
    const prepared = await prepareEntryEdit(db, userId, client, entryId, change);
    return prepared.ok ? result(prepared.proposal) : failure(prepared.error);
  }));
  server.registerTool("tomola_entry_edit_get", {
    description: "Read a pending edit proposal created by this client, its base entry version and the approval URL." + contentWarning,
    inputSchema: z.object({ id }), scopeChallenge: both, annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (args) => runDraftRead("tomola_entry_edit_get", async () => {
    if (!canRead()) return failure("The read scope is required.");
    const proposed = await getClientEntryEdit(db, userId, client, args.id);
    return proposed ? result(proposed) : failure("not_found");
  }));
  server.registerTool("tomola_entry_edit_status", {
    description: "Check the status of an edit proposal created by this client. Returns pending, applied, discarded or unknown with no post or proposal text." + contentWarning,
    inputSchema: z.object({ id }), scopeChallenge: requireScopes("draft"), annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (args) => runDraftRead("tomola_entry_edit_status", async () => result(await getClientEntryEditStatus(db, userId, client, args.id))));
  server.registerTool("tomola_entry_edit_discard", {
    description: "Discard a pending edit proposal created by this client at the specified version." + contentWarning,
    inputSchema: z.object({ id, expectedVersion: z.number().int().positive().max(2_147_483_647) }),
    scopeChallenge: requireScopes("draft"), annotations: { destructiveHint: true, openWorldHint: false },
  }, async (args) => runDraft("tomola_entry_edit_discard", async () => {
    const discarded = await discardEntryEdit(db, userId, args.id, args.expectedVersion, client);
    if (discarded) return result(await getClientEntryEditStatus(db, userId, client, args.id));
    const current = await getClientEntryEditStatus(db, userId, client, args.id);
    return failure(current.status === "unknown" ? "not_found" : "edit_conflict");
  }));
  server.registerTool("tomola_entry_delete_prepare", {
    description: "Return a browser confirmation URL and the effect on replies for a post or reply you wrote. The member confirms deletion in the browser." + contentWarning,
    inputSchema: z.object({ entryId: id }), scopeChallenge: both, annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (args) => runDraftRead("tomola_entry_delete_prepare", async () => {
    if (!canRead()) return failure("The read scope is required.");
    const review = await prepareEntryDeletion(db, userId, args.entryId);
    return review ? result(review) : failure("not_found");
  }));
}
