import { requireScopes, type McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Db } from "~/lib/db/client.server";
import type { Lang } from "~/lib/languages";
import { mdBlock } from "~/lib/md/frontmatter.server";
import { buildListMarkdown, type ListMdOptions } from "~/lib/md/lists.server";
import { siteUrl } from "~/lib/md/urls.server";
import { getWriter } from "~/lib/members.server";
import { DRAFT_RATE_LIMIT, hitRateLimit } from "~/lib/rate-limit.server";
import { VILLAGE_DESCRIPTION_MAX, VILLAGE_NAME_MAX, VILLAGE_SLUG_MAX } from "~/lib/villages";
import { villageBySlug, villageMembership } from "~/lib/villages.server";
import type { McpPrincipal } from "./auth.server";
import { MCP_CONTENT_WARNING, mcpText } from "./output.server";
import { createVillageProposal, discardClientVillageProposal, getClientVillageProposal, villageProposalPath } from "./village-proposals.server";

// Existing slugs include language tags reserved for system villages.
export const sharedVillageSlug = z.string().min(1).max(VILLAGE_SLUG_MAX).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/i);

export function memberVillageDirectory(db: Db, principal: McpPrincipal, lang: Lang | null) {
  return buildListMarkdown(db, principal.profile, { kind: "villages" }, { page: 1, lang, k: null });
}

export async function memberVillageMarkdown(db: Db, principal: McpPrincipal, slug: string, opts: ListMdOptions) {
  const village = await villageBySlug(db, slug);
  if (!village?.slug) return null;
  const membership = await villageMembership(db, village.id, principal.userId);
  const canManage = membership.owner && !village.language && (await getWriter(db, principal.userId)).ok;
  const canonical = siteUrl(`/v/${village.slug}`);
  const summary = mdBlock({
    type: "village_membership", canonical, slug: village.slug, joined: membership.joined, owner: membership.owner,
    member_count: membership.members, can_manage: canManage, can_change_icon: canManage && !village.endedAt,
  }, null);
  const list = await buildListMarkdown(db, principal.profile, { kind: "village", slug: village.slug, villageId: village.id }, {
    ...opts, mcpPageArgs: { slug: village.slug, lang: opts.lang ?? undefined, asks: opts.asks, long: opts.long, order: opts.order ?? undefined },
  });
  return `${summary}\n${list}`;
}

type VillageToolRunner = (tool: string, operation: () => Promise<ReturnType<typeof mcpText>>) => Promise<ReturnType<typeof mcpText>>;
const prepareInput = z.object({
  slug: sharedVillageSlug,
  name: z.string().max(VILLAGE_NAME_MAX * 2).optional(),
  description: z.string().max(VILLAGE_DESCRIPTION_MAX * 2).optional(),
  icon: z.discriminatedUnion("action", [
    z.object({ action: z.literal("reset") }),
    z.object({ action: z.literal("replace"), mediaId: z.string().regex(/^[a-f0-9]{64}$/) }),
  ]).optional(),
});
const proposalInput = z.object({ id: z.string().regex(/^[a-f0-9]{32}$/) });
const proposalScopes = requireScopes("read", "draft");
const proposalIconScopes = requireScopes("read", "draft", "media");
const failure = (code: string) => ({ ...mcpText(code, "error"), isError: true });

export function registerVillageProposalTools(server: McpServer, db: Db, principal: McpPrincipal, write: VillageToolRunner, read: VillageToolRunner) {
  const { userId, client, scopes } = principal;
  const render = (result: Awaited<ReturnType<typeof createVillageProposal>>) => result.ok
    ? mcpText(JSON.stringify({ ...result.proposal, approvalUrl: siteUrl(villageProposalPath(result.proposal.id)) }), "village_proposal")
    : failure(result.error);
  server.registerTool("tomola_village_change_prepare", {
    description: "Prepare an own-client change to a shared village you manage. Supply the proposed name, description or icon operation. Icon changes also require media permission. Upload a still image with POST /api/media for a replacement. Give the member approvalUrl to review and apply in the browser." + MCP_CONTENT_WARNING,
    inputSchema: prepareInput,
    scopeChallenge: context => {
      const parsed = prepareInput.safeParse(context.request.params?.arguments);
      return parsed.success && parsed.data.icon ? proposalIconScopes(context) : proposalScopes(context);
    },
    annotations: { destructiveHint: false, openWorldHint: false },
  }, async args => write("tomola_village_change_prepare", async () => {
    if (!scopes.has("read")) return failure("The read scope is required.");
    if (args.icon && !scopes.has("media")) return failure("The media scope is required for icon changes.");
    const rate = await hitRateLimit(db, { key: `draft:member:${userId}`, ...DRAFT_RATE_LIMIT });
    if (!rate.allowed) return failure("Draft creation rate limit reached.");
    return render(await createVillageProposal(db, userId, client, { ...args, slug: args.slug.toLowerCase() }));
  }));
  server.registerTool("tomola_village_change_get", {
    description: "Read a pending own-client village proposal and its review URL." + MCP_CONTENT_WARNING,
    inputSchema: proposalInput,
    scopeChallenge: proposalScopes,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ id }) => read("tomola_village_change_get", async () => scopes.has("read") ? render(await getClientVillageProposal(db, userId, client, id)) : failure("The read scope is required.")));
  server.registerTool("tomola_village_change_discard", {
    description: "Discard an own-client village proposal before browser approval." + MCP_CONTENT_WARNING,
    inputSchema: proposalInput,
    scopeChallenge: proposalScopes,
    annotations: { destructiveHint: true, openWorldHint: false },
  }, async ({ id }) => write("tomola_village_change_discard", async () => {
    if (!scopes.has("read")) return failure("The read scope is required.");
    return (await discardClientVillageProposal(db, userId, client, id)) ? mcpText("Proposal discarded.") : failure("not_found");
  }));
}
