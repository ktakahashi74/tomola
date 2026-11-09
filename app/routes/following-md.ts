import type { Route } from "./+types/following-md";
import { serveListMd } from "~/lib/md/twin.server";

// /following.md and /following.txt: the Markdown twin of the member's follow list (authenticated like the other twins: the session, the member's own read token or signed link).
// The list is the caller's own, so a read token gives the follows of the member it belongs to and nobody else's (app/lib/md/twin.server.ts).
export async function loader({ request }: Route.LoaderArgs) {
  return serveListMd(request, { kind: "following" });
}
