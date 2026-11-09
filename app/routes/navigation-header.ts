import type { Route } from "./+types/navigation-header";
import { loader as memberNavigation } from "./member-layout";
import { getSessionUser } from "~/lib/auth/session.server";

// Only the requesting browser's navigation data; never cache it with public document HTML.
export async function loader(args: Route.LoaderArgs): Promise<Response> {
  const { request } = args;
  const headers = { "Cache-Control": "private, no-store", Vary: "Cookie, Accept-Language", "X-Robots-Tag": "noindex" };
  if (!await getSessionUser(request)) return Response.json({ reader: true }, { headers });
  try { return Response.json(await memberNavigation({ request }), { headers }); }
  catch (error) {
    if (error instanceof Response && ["/login", "/onboarding"].includes(error.headers.get("Location")?.split("?")[0] ?? "")) return Response.json({ reader: true }, { headers });
    throw error;
  }
}
