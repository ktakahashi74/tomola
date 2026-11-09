import type { Route } from "./+types/home-md";
import { serveListMd } from "~/lib/md/twin.server";

// /home.md and /home.txt: Markdown home, including the local section and 「他の言語圏から」.
export async function loader({ request }: Route.LoaderArgs) {
  return serveListMd(request, { kind: "home" });
}
