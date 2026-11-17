import { APIError, addOAuthServerContext, freshSessionMiddleware, getOAuthState } from "better-auth/api";
import type { BetterAuthOptions } from "better-auth";
import { readInvitationCookie } from "./invitation-cookie.server";
import { safeLocalPath } from "~/lib/display-lang.server";

type BeforeContext = Parameters<typeof validateGoogleUser>[1];

// Only the server can bind an invitation to OAuth state. Client additionalData
// and requestSignUp never establish eligibility to create a user.
export async function prepareGoogleFlow(ctx: BeforeContext, secret: string, enabled: boolean) {
  const start = ctx.path === "/sign-in/social" || ctx.path === "/link-social";
  const callback = ctx.path === "/callback/:id" && ctx.params?.id === "google";
  if (!start && !callback) return;
  if (!enabled || (start && ctx.body?.provider !== "google")) throw new APIError("NOT_FOUND", { message: "Not found" });
  if (!start) return;
  if (ctx.body?.idToken) throw new APIError("NOT_FOUND", { message: "ID token sign-in is disabled" });
  if (ctx.path === "/link-social") await freshSessionMiddleware(ctx);
  const request = ctx.request ?? new Request(ctx.context.baseURL, { headers: ctx.headers });
  await addOAuthServerContext({ invitationId: ctx.path === "/sign-in/social" ? readInvitationCookie(request, secret) : null });
  const target = safeLocalPath(ctx.body?.callbackURL);
  const errorTarget = safeLocalPath(ctx.body?.errorCallbackURL);
  // Keep arbitrary scopes, authorization parameters and client state out of the
  // provider request. Never send an address as a Google login_hint.
  for (const key of Object.keys(ctx.body)) delete ctx.body[key];
  Object.assign(ctx.body, {
    provider: "google", callbackURL: target, newUserCallbackURL: "/onboarding",
    errorCallbackURL: ctx.path === "/link-social" ? "/settings?google=1#settings-google" : errorTarget.startsWith("/invite/") ? errorTarget : "/login?google=1",
  });
}

export function googleEmailFailure(profile: Record<string, unknown>): "google_unverified" | "google_unmanaged" | null {
  if (profile.email_verified !== true) return "google_unverified";
  const email = typeof profile.email === "string" ? profile.email.toLowerCase() : "";
  const domain = email.split("@")[1];
  if (!domain || (!["gmail.com", "googlemail.com"].includes(domain) && profile.hd !== domain)) return "google_unmanaged";
  return null;
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
  const failure = googleEmailFailure(source.oauth?.profile ?? {});
  if (failure) return { error: failure };
  if (!(await getOAuthState())?.serverContext?.invitationId) return { error: "google_invitation" };
};

export function maskGoogleInvitationEmail(email: string): string {
  const [local, domain] = email.split("@");
  return `${local.slice(0, 1)}***@${domain}`;
}
