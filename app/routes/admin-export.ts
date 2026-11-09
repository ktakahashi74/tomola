import type { Route } from "./+types/admin-export";
import { requireOperator } from "~/lib/auth/session.server";
import { buildObservationExport } from "~/lib/exports.server";
import { enforceMemberLimit } from "~/lib/http/limits.server";
import { currentEmbeddingModel } from "~/lib/llm/config.server";

// /admin/export: an operator-only JSON download; other members receive 404 (app/lib/exports.server.ts).
// Post metadata, translation types and engines, Insightful totals and language counts, question distributions, divergences and diversity metrics. No email addresses, user IDs, handles,
// titles, bodies, personal stances or change history; no per-question or per-post counts by area.
// Prevent storage and shared caching (Cache-Control: no-store).
export async function loader({ request }: Route.LoaderArgs) {
  const { db, user } = await requireOperator(request);
  await enforceMemberLimit(db, "export", user.id);
  const now = new Date();
  const body = await buildObservationExport(db, { model: currentEmbeddingModel(), now });
  return new Response(JSON.stringify(body, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="tomola-observation-${now.toISOString().slice(0, 10)}.json"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
