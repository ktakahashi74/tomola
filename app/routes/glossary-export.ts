import type { Route } from "./+types/glossary-export";
import { guarded, memberResponse, methodNotAllowed } from "~/lib/api/http.server";
import { authenticateRead } from "~/lib/api/read-auth.server";
import { buildGlossaryExport } from "~/lib/glossary-io.server";

// /glossary.yaml: glossary export download. Same content as pnpm glossary:export (buildGlossaryExport), in a format readable by pnpm glossary:import.
// Ignore filter parameters and always export all active entries for import/export round trips. Authentication matches Markdown endpoints (Cookie, read token, ?k=).
export async function loader({ request }: Route.LoaderArgs) {
  if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed(request, "text", "GET, HEAD");
  return guarded(request, "text", "glossary-export", async () => {
    const authed = await authenticateRead(request, "text");
    if (!authed.ok) return authed.response;
    const { auth } = authed;
    return memberResponse(request, await buildGlossaryExport(auth.db), {
      rate: auth.rate,
      headers: {
        "Content-Type": "text/yaml; charset=utf-8",
        "Content-Disposition": `attachment; filename="tomola-glossary-${new Date().toISOString().slice(0, 10)}.yaml"`,
      },
    });
  });
}
