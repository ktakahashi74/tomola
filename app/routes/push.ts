import type { Route } from "./+types/push";
import { handlePushRequest } from "~/lib/push/http.server";
export function action({ request, params }: Route.ActionArgs) { return handlePushRequest(request, params.operation); }
export function loader() { return new Response("Not found", { status: 404, headers: { "Cache-Control": "private, no-store" } }); }
