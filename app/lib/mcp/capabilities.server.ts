import { CONNECTIONS_SETTINGS_PATH, CONNECT_MD_PATH, MCP_SCOPES } from "~/lib/connect-paths";
import type { Db } from "~/lib/db/client.server";
import { siteUrl } from "~/lib/md/urls.server";
import { getWriter } from "~/lib/members.server";
import { publicReading } from "~/lib/public-reading.server";
import { villagesEnabled } from "~/lib/villages-enabled.server";
import type { McpPrincipal } from "./auth.server";

type Scope = typeof MCP_SCOPES[number];
type Availability =
  | { status: "available" | "disabled" | "browser_required" | "unsupported" }
  | { status: "missing_scope"; missingScopes: Scope[] }
  | { status: "writing_unavailable" };

export async function memberCapabilities(db: Db, principal: McpPrincipal) {
  const writer = await getWriter(db, principal.userId);
  const villages = villagesEnabled();
  const availability = (scopes: Scope[], options: { write?: boolean; enabled?: boolean } = {}): Availability => {
    if (options.enabled === false) return { status: "disabled" };
    const missingScopes = scopes.filter(scope => !principal.scopes.has(scope));
    if (missingScopes.length) return { status: "missing_scope", missingScopes };
    if (options.write && !writer.ok) return { status: "writing_unavailable" };
    return { status: "available" };
  };
  return {
    scopes: MCP_SCOPES.filter(scope => principal.scopes.has(scope)),
    writer: writer.ok ? { allowed: true } : { allowed: false, reason: writer.reason },
    features: { publicReading: publicReading(), villages },
    actions: {
      read: availability(["read"]),
      readVillages: availability(["read"], { enabled: villages }),
      readDrafts: availability(["draft"]),
      saveDrafts: availability(["draft"], { write: true }),
      uploadMedia: availability(["media"], { write: true }),
      prepareEntryEdit: availability(["read", "draft"], { write: true }),
      readEntryEdits: availability(["draft"]),
      readEntryEditContent: availability(["read", "draft"]),
      discardEntryEdits: availability(["draft"], { write: true }),
      prepareEntryDelete: availability(["read", "draft"]),
      prepareVillageChanges: availability(["read", "draft"], { write: true, enabled: villages }),
      prepareVillageIcon: availability(["read", "draft", "media"], { write: true, enabled: villages }),
      readVillageChanges: availability(["read", "draft"], { enabled: villages }),
      discardVillageChanges: availability(["read", "draft"], { write: true, enabled: villages }),
      publishDraft: { status: "browser_required" },
      applyEntryEdit: { status: "browser_required" },
      deleteEntry: { status: "browser_required" },
      applyVillageChanges: { status: villages ? "browser_required" : "disabled" },
      autoPublish: { status: "unsupported" },
      changeVillageMembership: { status: "unsupported" },
      readPrivateRecords: { status: "unsupported" },
    },
    links: {
      connectionGuide: siteUrl(CONNECT_MD_PATH),
      connections: siteUrl(CONNECTIONS_SETTINGS_PATH),
      tokens: siteUrl("/settings/tokens"),
      draftReview: siteUrl("/drafts"),
      villages: villages ? siteUrl("/villages") : undefined,
      uploadMedia: siteUrl("/api/media"),
    },
  };
}
