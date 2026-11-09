import type { Route } from "./+types/latest-md";
import { serveListMd } from "~/lib/md/twin.server";

// /latest.md and /latest.txt: Markdown recent posts (app/lib/md/twin.server.ts).
export async function loader({ request }: Route.LoaderArgs) {
  return serveListMd(request, { kind: "latest" });
}
