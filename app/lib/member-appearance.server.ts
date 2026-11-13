import { getSessionCookie } from "better-auth/cookies";
import { getSessionProfile } from "~/lib/auth/session.server";

export async function memberColorScheme(request: Request) {
  // Guests need no session lookup. Members reuse the profile read by locale
  // negotiation and route gates, including when a locale cookie takes priority.
  return getSessionCookie(request) ? (await getSessionProfile(request))?.colorScheme ?? null : null;
}
