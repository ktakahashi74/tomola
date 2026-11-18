import type { Route } from "./+types/writing-md";
import { writingMarkdown } from "~/lib/api/writing.server";
import { GUIDE_CONTENT_TYPE } from "~/lib/api/guides.server";
import { methodNotAllowed, publicResponse } from "~/lib/api/http.server";
import { mdBlock } from "~/lib/md/frontmatter.server";
import { siteUrl } from "~/lib/md/urls.server";
import { WRITING_PATH } from "~/lib/writing-paths";

// Public guidance only, independent of member access and public-reading settings.
export function loader({ request }: Route.LoaderArgs) {
  if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed(request, "text", "GET, HEAD");
  const body = mdBlock({ type: "page", id: "writing", lang: "en", canonical: siteUrl(WRITING_PATH) }, writingMarkdown());
  const response = publicResponse(request, body, GUIDE_CONTENT_TYPE);
  response.headers.set("X-Robots-Tag", "noindex");
  return response;
}
