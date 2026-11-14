import { eq } from "drizzle-orm";
import { data } from "react-router";
import type { Route } from "./+types/nushi-status";
import { getReader } from "~/lib/auth/session.server";
import { nushiAnswers, nushiRequests } from "~/lib/db/schema";
import { privateCacheMiddleware } from "~/lib/http/private-cache.server";
import { nushiCaller } from "~/lib/nushi-materials.server";
import { readNushiAnswer } from "~/lib/nushi.server";

export async function loader({ request, params }: Route.LoaderArgs) {
  const { db, user } = await getReader(request);
  const [row] = await db.select().from(nushiRequests).where(eq(nushiRequests.id, params.id));
  const headers = { "Cache-Control": "private, no-store" };
  if (!row) throw data("Not found", { status: 404, headers });
  if (row.callerId !== user?.id) {
    if (row.state === "answered") {
      const [answer] = await db.select({ id: nushiAnswers.id }).from(nushiAnswers).where(eq(nushiAnswers.requestId, row.id));
      const visible = answer && await readNushiAnswer(db, answer.id);
      if (!visible || visible.hidden) throw data("Not found", { status: 404, headers });
    } else if (!await nushiCaller(db, row)) throw data("Not found", { status: 404, headers });
  }
  // Never return the question, answer, source material or caller identity.
  return Response.json({ state: row.state }, { headers });
}

export const middleware = [privateCacheMiddleware];
