import type { Route } from "./+types/settings-export";
import { requireMember } from "~/lib/auth/session.server";
import { buildMemberExport } from "~/lib/exports.server";
import { enforceMemberLimit } from "~/lib/http/limits.server";

// /settings/export: a JSON download of the member's own posts and replies (including hidden ones), edit history, drafts, Insightful, stances and stance changes.
// Exclude other members' personal data; posts by other authors contribute only their IDs. Suspended members may export via requireMember because this is reading, not writing.
export async function loader({ request }: Route.LoaderArgs) {
  const { db, user } = await requireMember(request);
  await enforceMemberLimit(db, "export", user.id);
  const now = new Date();
  const body = await buildMemberExport(db, user.id, { now });
  return new Response(JSON.stringify(body, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="tomola-my-data-${now.toISOString().slice(0, 10)}.json"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
