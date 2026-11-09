import { eq } from "drizzle-orm";
import { user } from "../db/schema";
import { isDeletedIdentity } from "../deleted-member";
import { randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware, isAPIError } from "better-auth/api";
import { getDb, type Db } from "~/lib/db/client.server";
import { sessionAdapter } from "./session-adapter.server";
import { RETENTION } from "~/lib/retention";
import { safeErrorText } from "~/lib/error-text.server";
import { markInvitationUsed } from "~/lib/invitations.server";
import { getMailer, type Mailer } from "~/lib/mail/mail.server";
import { siteUrl } from "~/lib/site-url";
import { createMagicLinkSender } from "./magic-link.server";
import { authSecret } from "./secret.server";
import { authPlugins, type SendMagicLink } from "./plugins";
import { readInvitationCookie } from "./invitation-cookie.server";
import { rememberSignupInvitation } from "~/lib/signup-village.server";

type AuthOptions = { baseURL: string; secret: string; sendMagicLink: SendMagicLink; metadataFetch?: Parameters<typeof authPlugins>[1]["metadataFetch"] };
const g = globalThis as { __tomolaAuth?: Promise<Auth>; __tomolaAuthOptions?: WeakMap<object, AuthOptions> };
// Configuration must survive the same module reloads as the auth singleton.
const originalOptions = g.__tomolaAuthOptions ??= new WeakMap<object, AuthOptions>();
export function createAuth(db: Db, opts: AuthOptions) {
  const auth = betterAuth({
    baseURL: opts.baseURL,
    secret: opts.secret,
    session: { expiresIn: RETENTION.sessionDays * 86400, updateAge: 86400 },
    database: sessionAdapter(db),
    logger: { level: "warn", log: (level, message, ...args) => {
      const write = level === "error" ? console.error : level === "warn" ? console.warn : console.info;
      write("[auth]", safeErrorText([message, ...args]));
    } },
    hooks: { before: createAuthMiddleware(async ctx => {
      if (ctx.path === "/sign-in/magic-link" && isDeletedIdentity(undefined, ctx.body?.email)) return ctx.json({ status: true });
    }), after: createAuthMiddleware(async ctx => {
      if (ctx.path !== "/passkey/generate-authenticate-options") return;
      const result = ctx.context.returned;
      if (result && typeof result === "object" && "challenge" in result && typeof result.challenge === "string") return ctx.json({ ...result, userVerification: "required" });
    }) },
    plugins: authPlugins(opts.sendMagicLink, { baseURL: opts.baseURL, metadataFetch: opts.metadataFetch }),
    // Better Auth disables origin checks by default under NODE_ENV=test. Always enable them in every environment.
    // disableIpTracking: do not store IP addresses in sessions (minimize personal data). This also disables Better Auth's own HTTP rate limit
    // based on IPs, but the app has its own login rate limit (magic-link.server.ts) and an HTTP endpoint allowlist (endpoints.server.ts).
    advanced: { disableOriginCheck: false, ipAddress: { disableIpTracking: true } },
    databaseHooks: {
      session: {
        create: {
          // Better Auth stores user agents in sessions without a setting to disable this. Omit them. The setting above omits IPs, which arrive as empty strings; normalize them to null.
          before: async value => {
            const [account] = await db.select({ email: user.email }).from(user).where(eq(user.id, value.userId));
            if (isDeletedIdentity(value.userId, account?.email)) throw new APIError("UNAUTHORIZED", { message: "Invalid account" });
            return { data: { ipAddress: null, userAgent: null } };
          },
        },
      },
      user: {
        create: {
          // Do not create users for uninvited addresses. Atomically consume the invitation here before user creation (markInvitationUsed).
          // If two concurrent creations use the same invitation, only one can mark it used; the other affects zero rows and fails.
          // Choose the user id for used_by here and include it in the creation data (Better Auth uses the id returned by the hook as-is).
          before: async (newUser, context) => {
            if (isDeletedIdentity(newUser.id, newUser.email)) throw new APIError("FORBIDDEN", { message: "Invalid account" });
            const id = randomUUID();
            const request = context?.request ?? new Request(opts.baseURL, { headers: context?.headers ?? undefined });
            const invitationId = readInvitationCookie(request, opts.secret);
            const claimed = await markInvitationUsed(db, newUser.email, { usedBy: id, invitationId });
            if (claimed === 0) {
              throw new APIError("FORBIDDEN", { code: "INVITATION_REQUIRED", message: "invitation_required" });
            }
            try { await rememberSignupInvitation(db, id, invitationId); }
            catch (error) {
              // The invitation is already consumed. Keep registration usable
              // even when the optional village association cannot be saved.
              console.warn("[auth] Signup invitation association failed", { invitationId }, safeErrorText(error));
            }
            return { data: { ...newUser, id } };
          },
        },
      },
    },
  });
  originalOptions.set(auth, opts);
  return auth;
}

export type Auth = ReturnType<typeof createAuth>;

// Recreate plugins: OAuth discovery initialization mutates plugin options, so reusing plugin instances registers CIMD twice.
export function bindAuthToDatabase(auth: Auth, db: Db): Auth {
  const opts = originalOptions.get(auth);
  if (!opts) throw new Error("Unknown authentication configuration");
  return createAuth(db, opts);
}

// The app's Better Auth instance: send magic-link email through the mail system after checking rate limits and the recipient (app/lib/auth/magic-link.server.ts).
export function createAppAuth(
  db: Db,
  opts: { baseURL: string; secret: string; mailer: () => Mailer; now?: () => Date; isKnown?: (db: Db, email: string, now: Date) => Promise<boolean> },
) {
  return createAuth(db, {
    baseURL: opts.baseURL,
    secret: opts.secret,
    sendMagicLink: createMagicLinkSender({ db, baseURL: opts.baseURL, secret: opts.secret, mailer: opts.mailer, now: opts.now, isKnown: opts.isKnown }),
  });
}

// Whether an auth.api call was rejected by the origin check (403). This occurs when the address differs from BETTER_AUTH_URL.
// Rejection throws APIError only when the call receives request and uses asResponse: false.
export function isOriginRejected(error: unknown): boolean {
  return isAPIError(error) && error.statusCode === 403;
}

// Whether an auth.api call failed because of invalid input (400) or origin rejection (403).
export function isRejectedInput(error: unknown): boolean {
  return isOriginRejected(error) || (isAPIError(error) && error.statusCode === 400);
}

// BETTER_AUTH_SECRET moved to ./secret.server (keys of other modules, such as the rate limits, derive from it without loading Better Auth); re-exported for the existing imports.
export { authSecret };

// Public site URL (BETTER_AUTH_URL; http://localhost:5173 in development and tests; app/lib/site-url.ts).
export function authBaseURL(): string {
  return siteUrl();
}

// Do not retain rejected promises, allowing recovery from transient failures or misconfiguration without a restart.
export function getAuth(): Promise<Auth> {
  if (!g.__tomolaAuth) {
    const creating = getDb().then(async (db) => {
      const auth = createAppAuth(db, { baseURL: authBaseURL(), secret: authSecret(), mailer: getMailer });
      // Plugin initialization performs asynchronous schema/key work. Do not expose a half-initialized singleton.
      await auth.$context;
      return auth;
    });
    g.__tomolaAuth = creating;
    creating.catch(() => {
      if (g.__tomolaAuth === creating) g.__tomolaAuth = undefined;
    });
  }
  return g.__tomolaAuth;
}
