import { describe, expect, it } from "vitest";
import { createAuth, isOriginRejected, isRejectedInput } from "~/lib/auth/auth.server";
import { createTestDb } from "./helpers/db";

const BASE = "http://localhost:5173";

async function setup() {
  const db = await createTestDb();
  const sent: string[] = [];
  const auth = createAuth(db, {
    baseURL: BASE,
    secret: "test-secret-0123456789abcdef0123456789abcdef",
    sendMagicLink: async ({ email }) => {
      sent.push(email);
    },
  });
  return { auth, sent };
}

function formPost(headers: Record<string, string>): Request {
  return new Request(`${BASE}/login`, { method: "POST", headers });
}

// Same calling shape as routes/login.tsx and routes/invite.tsx.
function signIn(auth: Awaited<ReturnType<typeof setup>>["auth"], request: Request, email = "alice@example.com") {
  return auth.api.signInMagicLink({
    body: { email, callbackURL: "/" },
    headers: request.headers,
    request,
    asResponse: false,
  });
}

describe("magic link origin checks", () => {
  it("accepts a form post from the same origin", async () => {
    const { auth, sent } = await setup();
    await expect(signIn(auth, formPost({ origin: BASE }))).resolves.toEqual({ status: true });
    expect(sent).toEqual(["alice@example.com"]);
  });

  it("rejects a form post from another origin and sends nothing", async () => {
    const { auth, sent } = await setup();
    const error = await signIn(auth, formPost({ origin: "https://evil.example" })).catch((e: unknown) => e);
    expect(error).toMatchObject({ statusCode: 403, body: { code: "INVALID_ORIGIN" } });
    expect(isRejectedInput(error)).toBe(true);
    expect(isOriginRejected(error)).toBe(true);
    expect(sent).toEqual([]);
  });

  it("rejects a cross-site navigation even without an Origin header", async () => {
    const { auth, sent } = await setup();
    const request = formPost({ "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" });
    const error = await signIn(auth, request).catch((e: unknown) => e);
    expect(error).toMatchObject({ statusCode: 403 });
    expect(sent).toEqual([]);
  });

  it("turns invalid email input into a rejected-input error", async () => {
    const { auth, sent } = await setup();
    const error = await signIn(auth, formPost({ origin: BASE }), "taro@gmail").catch((e: unknown) => e);
    expect(error).toMatchObject({ statusCode: 400 });
    expect(isRejectedInput(error)).toBe(true);
    // Handle invalid input separately from an origin rejection; the UI wording differs.
    expect(isOriginRejected(error)).toBe(false);
    expect(sent).toEqual([]);
  });

  it("does not treat unrelated errors as rejected input", () => {
    expect(isRejectedInput(new Error("boom"))).toBe(false);
    expect(isOriginRejected(new Error("boom"))).toBe(false);
  });
});
