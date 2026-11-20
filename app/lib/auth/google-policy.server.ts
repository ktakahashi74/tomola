import { APIError, addOAuthServerContext, freshSessionMiddleware, getOAuthState } from "better-auth/api";
import type { BetterAuthOptions } from "better-auth";
import { AsyncLocalStorage } from "node:async_hooks";
import { safeLocalPath } from "~/lib/display-lang.server";

type BeforeContext = Parameters<typeof validateGoogleUser>[1];
export const googleInvitationContext = new AsyncLocalStorage<string | null>();

// Only the server can bind an invitation to OAuth state. Client additionalData
// and requestSignUp never establish eligibility to create a user.
export async function prepareGoogleFlow(ctx: BeforeContext, enabled: boolean) {
  const start = ctx.path === "/sign-in/social" || ctx.path === "/link-social";
  const callback = ctx.path === "/callback/:id" && ctx.params?.id === "google";
  if (!start && !callback) return;
  // Replace only this endpoint's logger, leaving passkey and MCP diagnostics intact.
  const logger = ctx.context.logger;
  ctx.context.logger = { ...logger,
    error: () => logger.error("Google authentication request failed"),
    warn: () => logger.warn("Google authentication request failed"),
    info: () => logger.info("Google authentication request failed"),
    debug: () => logger.debug("Google authentication request failed"),
    success: () => logger.success("Google authentication request failed"),
  };
  if (!enabled || (start && ctx.body?.provider !== "google")) throw new APIError("NOT_FOUND", { message: "Not found" });
  if (!start) return;
  if (ctx.body?.idToken) throw new APIError("NOT_FOUND", { message: "ID token sign-in is disabled" });
  if (ctx.path === "/link-social") await freshSessionMiddleware(ctx);
  const invitationId = ctx.path === "/sign-in/social" ? googleInvitationContext.getStore() ?? null : null;
  await addOAuthServerContext({ invitationId });
  const targetPath = new URL(safeLocalPath(ctx.body?.callbackURL), ctx.context.baseURL).pathname;
  // State is stored in plaintext. Keep invite links, query values and fragments
  // out of every return URL. Decode only for checks and keep the encoded path.
  let callbackURL = "/";
  try {
    const decodedPath = decodeURIComponent(targetPath);
    if (!decodedPath.startsWith("//") && !/[\\\x00-\x1f\x7f]/.test(decodedPath)
      && !/^\/(?:invite|auth|api\/auth)(?:[/?#]|$)/i.test(decodedPath)) callbackURL = targetPath;
  } catch { /* Invalid encoding returns home. */ }
  // Keep arbitrary scopes, authorization parameters and client state out of the
  // provider request. Never send an address as a Google login_hint.
  for (const key of Object.keys(ctx.body)) delete ctx.body[key];
  Object.assign(ctx.body, {
    provider: "google", callbackURL: ctx.path === "/link-social" ? "/settings#settings-google" : callbackURL, newUserCallbackURL: "/onboarding",
    errorCallbackURL: ctx.path === "/link-social" ? "/settings?google=1#settings-google" : invitationId ? "/invite?google=1" : "/login?google=1",
  });
}

export function googleEmailFailure(profile: Record<string, unknown>): "google_unverified" | "google_unmanaged" | null {
  if (profile.email_verified !== true) return "google_unverified";
  const email = typeof profile.email === "string" ? profile.email.toLowerCase() : "";
  const domain = email.split("@")[1];
  if (!domain || (!["gmail.com", "googlemail.com"].includes(domain) && profile.hd !== domain)) return "google_unmanaged";
  return null;
}

export function finishGoogleFlow(ctx: Pick<BeforeContext, "path" | "params"> & { context: { baseURL: string; responseHeaders?: Headers } }) {
  if (ctx.path !== "/callback/:id" || ctx.params?.id !== "google") return;
  const headers = ctx.context.responseHeaders;
  const location = headers?.get("location");
  if (!headers || !location) return;
  const base = new URL(ctx.context.baseURL);
  const url = URL.parse(location, base);
  // Enforce the return boundary even for state issued before the path checks.
  if (!url || url.protocol !== base.protocol || url.origin !== base.origin || url.pathname.startsWith("//")) {
    headers.set("location", "/");
    return;
  }
  // Better Auth adds a description for a rejected new user but omits it for
  // an existing unlinked user. Normalize that observable difference as well.
  if (url.pathname === "/login" && url.searchParams.get("error") === "account_not_linked") {
    headers.set("location", "/login?google=1&error=account_not_linked");
  }
}

export const validateGoogleUser: NonNullable<NonNullable<BetterAuthOptions["user"]>["validateUserInfo"]> = async ({ source }, ctx) => {
  if (source.method !== "oauth" || source.oauth?.providerId !== "google") return;
  if (source.action === "link-account") {
    try {
      await freshSessionMiddleware(ctx);
      const state = await getOAuthState();
      if (!state?.link || ctx.context.session?.user.id !== state.link.userId) return { error: "google_reauth" };
    } catch { return { error: "google_reauth" }; }
    return;
  }
  if (source.action !== "create-user") return;
  // Match the existing unlinked-account failure before inspecting email claims:
  // ordinary login must not reveal whether this address belongs to a member.
  if (!(await getOAuthState())?.serverContext?.invitationId) return { error: "account_not_linked" };
  const failure = googleEmailFailure(source.oauth?.profile ?? {});
  if (failure) return { error: failure };
};

export function maskGoogleInvitationEmail(email: string): string {
  const [local, domain] = email.split("@");
  return `${local.slice(0, 1)}***@${domain}`;
}
