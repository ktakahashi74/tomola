import type { Route } from "./+types/entry-history-md";
import { serveHistoryMarkdown } from "~/lib/md/history-http.server";

export function loader({ request, params }: Route.LoaderArgs) { return serveHistoryMarkdown(request, params.id); }
