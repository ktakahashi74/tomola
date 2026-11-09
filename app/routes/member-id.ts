import { eq } from "drizzle-orm";
import { data, redirect } from "react-router";
import type { Route } from "./+types/member-id";
import { requireMember } from "~/lib/auth/session.server";
import { profiles } from "~/lib/db/schema";
import { privateCacheMiddleware } from "~/lib/http/private-cache.server";

export const middleware: Route.MiddlewareFunction[] = [privateCacheMiddleware];

export async function loader({ request, params }: Route.LoaderArgs) {
  const { db } = await requireMember(request);
  const headers = { "Cache-Control": "private, no-store" };
  if (!params.publicId || !/^[a-z0-9]{12}$/.test(params.publicId)) throw data("Not found", { status: 404, headers });
  const [person] = await db.select({ handle: profiles.handle }).from(profiles).where(eq(profiles.publicId, params.publicId));
  if (!person) throw data("Not found", { status: 404, headers });
  throw redirect(`/u/${person.handle}`, { status: 302, headers });
}
