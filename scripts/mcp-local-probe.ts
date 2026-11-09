// Local client interoperability fixture. No real member data, external model calls or persisted database.
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { createAuth } from "../app/lib/auth/auth.server";
import { migrationsFolder } from "../app/lib/db/client.server";
import { PGLITE_EXTENSIONS } from "../app/lib/db/pglite.server";
import * as schema from "../app/lib/db/schema";
import { createProfile } from "../app/lib/profiles.server";
import { createApiToken } from "../app/lib/tokens.server";
import { handleMcpRequest } from "../app/lib/mcp/server.server";
import { handleOAuthHttp } from "../app/lib/mcp/oauth-http.server";
import { isAllowedAuthEndpoint } from "../app/lib/auth/endpoints.server";
import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";
import { authorizationRedirect, loadConsentRequest } from "../app/lib/mcp/consent.server";

const directory = process.argv[2];
if (!directory || !process.env.TMPDIR || !path.resolve(directory).startsWith(path.resolve(process.env.TMPDIR, "..") + path.sep) || process.env.NODE_ENV === "production") throw new Error("Use an explicit fixture directory inside the task cache; never production.");
if (process.env.GEMINI_API_KEY || process.env.ANTHROPIC_API_KEY) throw new Error("Real model keys must be empty.");
fs.mkdirSync(directory, { recursive: true });
const client = new PGlite({ extensions: PGLITE_EXTENSIONS });
const db = drizzle({ client, schema });
await migrate(db, { migrationsFolder: migrationsFolder() });
await db.insert(schema.user).values({ id: "probe-member", name: "", email: "probe@example.invalid", emailVerified: true });
await createProfile(db, "probe-member", { handle: "probe_member", homeArea: "ja", readLangs: ["ja", "en"] });
const token = await createApiToken(db, "probe-member", { kind: "read", name: "isolated client probe" });
if (!token.ok) throw new Error(token.error);
let origin: string;
let auth: ReturnType<typeof createAuth>;
const server = createServer(async (incoming, outgoing) => {
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of incoming) { size += chunk.length; if (size > 256 * 1024) { outgoing.writeHead(413).end(); return; } chunks.push(Buffer.from(chunk)); }
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const request = new Request(`${origin}${incoming.url}`, { method: incoming.method, headers: incoming.headers as HeadersInit, ...(body ? { body } : {}) });
    if (new URL(request.url).pathname === "/mcp" && body) {
      const message = JSON.parse(body.toString());
      const reported = message.params?.clientInfo ?? message.params?._meta?.["io.modelcontextprotocol/clientInfo"];
      // Metadata only: never log arguments, headers, query values or credentials.
      fs.appendFileSync(path.join(directory, "wire.jsonl"), JSON.stringify({ method: message.method, client: typeof reported?.name === "string" ? reported.name.slice(0, 64) : null, protocol: message.params?.protocolVersion ?? message.params?._meta?.["io.modelcontextprotocol/protocolVersion"] ?? incoming.headers["mcp-protocol-version"] ?? null }) + "\n");
    }
    const pathname = new URL(request.url).pathname;
    let response: Response;
    if (pathname === "/mcp") response = await handleMcpRequest(request, { db, auth, baseURL: origin });
    else if (pathname.startsWith("/.well-known/oauth-protected-resource")) response = Response.json({ resource: `${origin}/mcp`, authorization_servers: [`${origin}/api/auth`], scopes_supported: ["read", "draft"] });
    else if (pathname.startsWith("/.well-known/oauth-authorization-server")) response = await oauthProviderAuthServerMetadata(auth)(request);
    else if (pathname === "/mcp/consent" && request.method === "GET") {
      // Fixture automation approves only this fictional member, after normal signed-query/session validation.
      const session = await auth.api.getSession({ headers: request.headers });
      if (session?.user.id !== "probe-member") response = new Response(null, { status: 403 });
      else {
        const consent = await loadConsentRequest(db, auth, new URL(request.url).searchParams.toString());
        const headers = new Headers(request.headers); headers.set("origin", origin);
        const approved = await auth.api.oauth2Consent({ headers, request: new Request(`${origin}/mcp/consent`, { method: "POST", headers }), body: { accept: true, scope: consent.scopes.join(" "), oauth_query: consent.query } });
        response = new Response(null, { status: 302, headers: { location: (await authorizationRedirect(approved))! } });
      }
    } else response = isAllowedAuthEndpoint(request) ? await handleOAuthHttp(request, db, auth, origin) : new Response(null, { status: 404 });
    outgoing.statusCode = response.status;
    for (const [key, value] of response.headers) outgoing.setHeader(key, value);
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch { outgoing.writeHead(500).end("Fixture unavailable"); }
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
process.env.BETTER_AUTH_URL = origin;
let magicToken = "";
auth = createAuth(db, { baseURL: origin, secret: "isolated-fixture-secret-01234567890123456789", sendMagicLink: async ({ token }) => { magicToken = token; } });
await auth.api.signInMagicLink({ headers: new Headers(), body: { email: "probe@example.invalid" } });
const verified = await auth.api.magicLinkVerify({ headers: new Headers(), query: { token: magicToken }, asResponse: true });
const cookie = verified.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
fs.writeFileSync(path.join(directory, "fixture.json"), JSON.stringify({ url: `${origin}/mcp`, token: token.token, cookie }), { mode: 0o600 });
console.info(`Local MCP fixture listening at ${origin}/mcp`);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
  server.closeAllConnections();
  server.close(() => { void client.close().then(() => process.exit(0)); });
});
