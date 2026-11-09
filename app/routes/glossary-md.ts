import type { Route } from "./+types/glossary-md";
import { errorResponse, guarded, memberResponse, methodNotAllowed, notFound } from "~/lib/api/http.server";
import { authenticateRead } from "~/lib/api/read-auth.server";
import { enabledLangs, isEnabledLang } from "~/lib/enabled-langs.server";
import { buildGlossaryMarkdown } from "~/lib/md/glossary.server";
import { parsePageParam } from "~/lib/pagination";

// /glossary.md and /glossary.txt: Markdown glossary (app/lib/md/glossary.server.ts). Read authentication matches other Markdown endpoints (Cookie, read token, ?k=).
// ?to= and ?from= require enabled languages (ENABLED_LANGS), otherwise 400. ?deleted=1 selects deleted entries; invalid ?page= returns 404. Default: no filters. Ignore ?lang= because glossary entries are not translated.
export async function loader({ request }: Route.LoaderArgs) {
  if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed(request, "text", "GET, HEAD");
  return guarded(request, "text", "md-glossary", async () => {
    const authed = await authenticateRead(request, "text");
    if (!authed.ok) return authed.response;
    const { auth } = authed;
    const params = new URL(request.url).searchParams;
    const page = parsePageParam(params.get("page"));
    if (page === null) return notFound(request, "text");
    const to = params.get("to");
    const from = params.get("from");
    for (const [name, value] of [["to", to], ["from", from]] as const) {
      if (value !== null && !isEnabledLang(value)) return errorResponse(request, "text", 400, "invalid_lang", `?${name}= must be one of the languages of this site: ${enabledLangs().join(", ")}.`);
    }
    const markdown = await buildGlossaryMarkdown(auth.db, null, {
      from: isEnabledLang(from) ? from : null,
      to: isEnabledLang(to) ? to : null,
      deleted: params.get("deleted") === "1",
      page,
      k: auth.carryK,
    });
    return memberResponse(request, markdown, { rate: auth.rate });
  });
}
