import { acceptTrialFixture } from "./trial";
import { eq } from "drizzle-orm";
import { createAuth } from "~/lib/auth/auth.server";
import { magicLinkBrowser } from "~/lib/auth/magic-link-browser.server";
import { magicLinkOutcome } from "~/lib/auth/magic-link.server";
import type { Db } from "~/lib/db/client.server";
import { profiles, user } from "~/lib/db/schema";
import { createInvitation } from "~/lib/invitations.server";
import type { Area, Lang } from "~/lib/languages";
import { createProfile } from "~/lib/profiles.server";
import { createTestDb } from "./db";
import { attachSigningProof, signingCredential, type TestSigningCredential } from "./signing";
import { SigningError, signingErrorResponse } from "~/lib/signing.server";

// Call route loaders and actions with real login: invitation, magic link, then session cookie.
// Call setupRouteHarness() in beforeAll and restore() in afterAll to restore replaced globals.
export const BASE = "http://localhost:5173";
const SECRET = "test-secret-0123456789abcdef0123456789abcdef";

type G = { __tomolaDb?: Promise<Db>; __tomolaAuth?: Promise<ReturnType<typeof createAuth>> };
const g = globalThis as G;

export type Outcome = { status: number; location: string | null; value?: unknown };

export type RouteHarness = {
  db: Db;
  ids: Record<string, string>;
  signIn(handle: string, opts?: { homeArea?: Area; readLangs?: Lang[]; email?: string; profile?: boolean }): Promise<string>;
  // Create an invitation, request a magic link and return its unverified email token for confirmation-page tests.
  issueLink(email: string, next?: string): Promise<string>;
  linkCookie(token: string): string;
  request(path: string, opts?: { as?: string; form?: Record<string, string | string[]>; headers?: Record<string, string> }): Request;
  args(req: Request, params?: Record<string, string>): never;
  signedArgs(req: Request, params?: Record<string, string>): Promise<never>;
  outcome(run: () => unknown): Promise<Outcome>;
  restore(): void;
};

export async function setupRouteHarness(): Promise<RouteHarness> {
  const saved: G = { __tomolaDb: g.__tomolaDb, __tomolaAuth: g.__tomolaAuth };
  const db = await createTestDb();
  g.__tomolaDb = Promise.resolve(db);
  const cookies: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const signingKeys = new Map<string, TestSigningCredential>();
  const linkCookies = new Map<string, string>();

  async function issueLink(email: string, next?: string): Promise<string> {
    const sent: string[] = [];
    const auth = createAuth(db, {
      baseURL: BASE,
      secret: SECRET,
      sendMagicLink: async ({ url }) => {
        sent.push(url);
        // Record the delivery result where an outcome is being observed (login actions), as the real sender does; otherwise a later action call would report "later" for a known address.
        const outcome = magicLinkOutcome.getStore();
        if (outcome) outcome.result = "sent";
      },
    });
    g.__tomolaAuth = Promise.resolve(auth);
    await createInvitation(db, { email });
    const browser = magicLinkBrowser(new Request(BASE));
    await auth.api.signInMagicLink({ body: { email, metadata: { browserNonce: browser.nonce, next } }, headers: new Headers() });
    const token = new URL(sent.at(-1)!).searchParams.get("token")!;
    linkCookies.set(token, browser.cookie.split(";")[0]);
    return token;
  }

  async function signIn(handle: string, opts: { homeArea?: Area; readLangs?: Lang[]; email?: string; profile?: boolean } = {}) {
    const email = opts.email ?? `${handle}@example.com`;
    const token = await issueLink(email);
    const auth = await g.__tomolaAuth!;
    const res = await auth.api.magicLinkVerify({ query: { token, callbackURL: "/" }, headers: new Headers(), asResponse: true });
    cookies[handle] = res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const [u] = await db.select({ id: user.id }).from(user).where(eq(user.email, email));
    ids[handle] = u.id;
    if (opts.profile !== false) {
      const readLangs = opts.readLangs ?? ["ja"];
      const created = await createProfile(db, u.id, { handle, homeArea: opts.homeArea ?? "ja", readLangs });
      if (!created.ok) throw new Error(`profile failed: ${created.error}`);
      await acceptTrialFixture(db, u.id);
    }
    return u.id;
  }

  return {
    db,
    ids,
    signIn,
    issueLink,
    linkCookie: (token) => linkCookies.get(token) ?? "",
    request(path, opts = {}) {
      const headers: Record<string, string> = { origin: BASE, ...opts.headers };
      if (opts.as) headers.cookie = cookies[opts.as];
      const init: RequestInit = { headers };
      if (opts.form) {
        init.method = "POST";
        const body = new URLSearchParams();
        for (const [name, value] of Object.entries(opts.form)) for (const v of Array.isArray(value) ? value : [value]) body.append(name, v);
        init.body = body;
      }
      return new Request(`${BASE}${path}`, init);
    },
    async signedArgs(req, params = {}) {
      if (req.method === "POST") {
        const form = await req.clone().formData();
        const path = new URL(req.url).pathname;
        const intent = String(form.get("intent") ?? "");
        const named = ((path === "/" || path === "/t/new" || /^\/t\/\d+$/.test(path)) && !["draft", "delete", "report", "flag"].includes(intent))
          || /^\/(t|c)\/\d+\/edit$/.test(path) || (/^\/drafts\/\d+$/.test(path) && intent === "publish")
          || (path === "/settings" && ["handle", "delete-passkey", "sign-posts"].includes(intent));
        const handle = Object.keys(cookies).find(h => cookies[h] === req.headers.get("cookie"));
        if (named && handle && req.headers.get("origin") === BASE) {
          const userId = ids[handle];
          const [profile] = await db.select({ signPosts: profiles.signPosts }).from(profiles).where(eq(profiles.userId, userId));
          if (!profile?.signPosts && !["delete-passkey", "sign-posts"].includes(intent)) return { request: req, params, context: {} } as never;
          let key = signingKeys.get(userId);
          if (!key) { key = await signingCredential(db, userId); signingKeys.set(userId, key); }
          try { req = await attachSigningProof(db, userId, req, key); }
          catch (error) { if (error instanceof SigningError) throw signingErrorResponse(error); throw error; }
        }
      }
      return { request: req, params, context: {} } as never;
    },
    args: (req, params = {}) => ({ request: req, params, context: {} }) as never,
    // Convert route throws, including redirect Responses and data() errors, into status and destination.
    async outcome(run) {
      try {
        const value = await run();
        if (value instanceof Response) return { status: value.status, location: value.headers.get("location"), value };
        const init = (value as { init?: { status?: number } } | null)?.init;
        return { status: init?.status ?? 200, location: null, value };
      } catch (thrown) {
        if (thrown instanceof Response) return { status: thrown.status, location: thrown.headers.get("location"), value: { data: await thrown.clone().json().catch(() => null) } };
        const init = (thrown as { init?: { status?: number } }).init;
        if (init) return { status: init.status ?? 500, location: null };
        throw thrown;
      }
    },
    restore() {
      g.__tomolaDb = saved.__tomolaDb;
      g.__tomolaAuth = saved.__tomolaAuth;
    },
  };
}
