import { authBaseURL } from "~/lib/auth/auth.server";
import { getDb } from "~/lib/db/client.server";
import { handlePublicMcpRequest } from "~/lib/mcp/server.server";
import type { Route } from "./+types/mcp-public";

const handle = async (request: Request) => handlePublicMcpRequest(request, { db: await getDb(), baseURL: authBaseURL() });
export const loader = ({ request }: Route.LoaderArgs) => handle(request);
export const action = ({ request }: Route.ActionArgs) => handle(request);
