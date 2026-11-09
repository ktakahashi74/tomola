import { authBaseURL, getAuth } from "~/lib/auth/auth.server";
import { getDb } from "~/lib/db/client.server";
import { handleMcpRequest } from "~/lib/mcp/server.server";
import type { Route } from "./+types/mcp";
const handle = async (request: Request) => handleMcpRequest(request, { db: await getDb(), auth: await getAuth(), baseURL: authBaseURL() });
export const loader = ({ request }: Route.LoaderArgs) => handle(request);
export const action = ({ request }: Route.ActionArgs) => handle(request);
