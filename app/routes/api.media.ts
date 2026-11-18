import type { Route } from "./+types/api.media";
import { handleMediaUpload } from "~/lib/api/media-api.server";

export function action({ request }: Route.ActionArgs) { return handleMediaUpload(request); }
export function loader({ request }: Route.LoaderArgs) { return handleMediaUpload(request); }
