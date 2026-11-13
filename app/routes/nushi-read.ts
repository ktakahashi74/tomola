import type { Route } from "./+types/nushi-read";
import { getReader } from "~/lib/auth/session.server";
import { readNushiAnswer } from "~/lib/nushi.server";
import { displayLangFor } from "~/lib/display-lang.server";
import { nushiBody } from "~/lib/nushi-markdown.server";

export async function loader({ request, params }: Route.LoaderArgs) {
  const { db, profile } = await getReader(request);
  const value = await readNushiAnswer(db, Number(params.id), displayLangFor(request, profile));
  const headers = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" };
  if (!value) return new Response("Not found", { status: 404, headers });
  const body = { authorKind: "ai", author: "Nushi", ...value };
  return new URL(request.url).pathname.endsWith(".json") ? Response.json(body, { headers }) : new Response(nushiBody(value), { headers: { ...headers, "Content-Type": "text/markdown; charset=utf-8" } });
}
