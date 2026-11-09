import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { createAuth } from "~/lib/auth/auth.server";
import { verifyLocalMcpJwt } from "~/lib/mcp/jwt.server";
import { verifyJwsAccessToken } from "better-auth/oauth2";
import { createTestDb } from "./helpers/db";

const origin = "https://unreachable.tomola.invalid";
let auth: ReturnType<typeof createAuth>;
let token: string;
const claims = () => ({ sub: "fixture-member", client_id: "fixture-client", scope: "read draft", tomola_consent: "fixture-consent", aud: `${origin}/mcp` });
const request = (value: string) => new Request(`${origin}/mcp`, { method: "POST", headers: { authorization: `Bearer ${value}` } });

beforeAll(async () => {
  auth = createAuth(await createTestDb(), { baseURL: origin, secret: "fictional-test-secret-0123456789abcdef", sendMagicLink: async () => {} });
  await auth.$context;
  token = (await auth.api.signJWT({ body: { payload: claims() } })).token;
});
afterEach(() => vi.restoreAllMocks());

describe("MCP JWT verification behind a TLS proxy", () => {
  it("uses local provider keys for an unreachable public HTTPS issuer without network access", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Public hostname is unreachable from this container"));
    expect(await verifyLocalMcpJwt(request(token), auth, origin)).toMatchObject(claims());
    expect(network).not.toHaveBeenCalled();
  });

  it("rejects payload changes made without the signing key", async () => {
    const [header, payload, signature] = token.split(".");
    const modified = { ...JSON.parse(Buffer.from(payload, "base64url").toString()), client_id: "another-client" };
    expect(await verifyLocalMcpJwt(request(`${header}.${Buffer.from(JSON.stringify(modified)).toString("base64url")}.${signature}`), auth, origin)).toBeNull();
  });

  it("rejects padding and unused-bit aliases of identical signature bytes", async () => {
    const [header, payload, signature] = token.split(".");
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = alphabet.indexOf(signature.at(-1)!);
    const alias = signature.slice(0, -1) + alphabet[last + 1];
    expect(Buffer.from(alias, "base64url")).toEqual(Buffer.from(signature, "base64url"));
    for (const value of [signature + "=".repeat((4 - signature.length % 4) % 4), alias]) {
      // The installed provider accepts these identical signature bytes. The
      // application must reject their spelling before digest-based revocation.
      expect(await verifyJwsAccessToken(`${header}.${payload}.${value}`, {
        jwksFetch: () => auth.api.getJwks(), jwksCacheKey: auth,
        verifyOptions: { issuer: `${origin}/api/auth`, audience: `${origin}/mcp` },
      })).toMatchObject(claims());
      expect(await verifyLocalMcpJwt(request(`${header}.${payload}.${value}`), auth, origin)).toBeNull();
    }
  });

  it.each([
    ["issuer", { iss: "https://another-issuer.invalid/api/auth" }],
    ["audience", { aud: `${origin}/another-resource` }],
    ["expiration", { exp: Math.floor(Date.now() / 1000) - 1 }],
    ["not-before", { nbf: Math.floor(Date.now() / 1000) + 300 }],
    ["sender constraint", { cnf: { jkt: "fictional-bound-key" } }],
  ])("rejects a correctly signed token with an invalid %s", async (_name, invalid) => {
    const signed = await auth.api.signJWT({ body: { payload: { ...claims(), ...invalid } } });
    expect(await verifyLocalMcpJwt(request(signed.token), auth, origin)).toBeNull();
  });

  it("isolates key caches for two authentication instances using the same issuer", async () => {
    const other = createAuth(await createTestDb(), { baseURL: origin, secret: "other-fictional-test-secret-0123456789", sendMagicLink: async () => {} });
    await other.$context;
    const signed = await other.api.signJWT({ body: { payload: claims() } });
    expect(await verifyLocalMcpJwt(request(signed.token), other, origin)).toMatchObject(claims());
    expect(await verifyLocalMcpJwt(request(signed.token), auth, origin)).toBeNull();
  });
});
