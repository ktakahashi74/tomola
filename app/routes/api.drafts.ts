import type { Route } from "./+types/api.drafts";
import { handleDraftCreate } from "~/lib/api/drafts-api.server";

// POST /api/drafts: create drafts (app/lib/api/drafts-api.server.ts). Authenticate only with a draft Bearer token.
export async function action({ request }: Route.ActionArgs) {
  return handleDraftCreate(request);
}

// GET, HEAD, and OPTIONS return 405 without CORS headers.
export async function loader({ request }: Route.LoaderArgs) {
  return handleDraftCreate(request);
}
