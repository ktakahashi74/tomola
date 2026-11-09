import { isDeletedIdentity } from "../deleted-member";
import { trialParticipationRequired } from "~/lib/notice-sources.server";
import { needsTrialConsent } from "~/lib/trial-consent.server";
import { data, redirect } from "react-router";
import { getDb, type Db } from "~/lib/db/client.server";
import { getActiveMember, getWriter } from "~/lib/members.server";
import type { Profile } from "~/lib/profiles.server";
import { ensureOperatorRow, getModScope, isModerator, type ModScope } from "~/lib/roles.server";
import { getAuth } from "./auth.server";
import { isCredentialSessionFresh } from "./credential-session.server";
import { collectSessionCookies } from "./session-cookies.server";
import { hitBrowserReadLimit, hitPublicReadLimit, rateLimitHeaders } from "~/lib/rate-limit.server";
import { publicReading } from "~/lib/public-reading.server";
import { readerLoginHref } from "~/lib/public-reading";
import { setMarkdownMember } from "~/lib/markdown-budget.server";

export type SessionUser = { id: string; email: string; name: string };

// Creation time of the session that authenticated each request, for the
// credential-freshness check below (kept out of SessionUser so it is never serialized).
const sessionCreatedAt = new WeakMap<Request, unknown>();

async function getSessionUserImplementation(request: Request): Promise<SessionUser | null> {
  const auth = await getAuth();
  // Attach session-refresh and invalid-cookie deletion Set-Cookie headers to the response via root middleware (session-cookies.server.ts).
  const { headers, response: session } = await auth.api.getSession({ headers: request.headers, returnHeaders: true });
  collectSessionCookies(headers);
  if (!session || isDeletedIdentity(session.user.id, session.user.email)) return null;
  sessionCreatedAt.set(request, session.session?.createdAt);
  return { id: session.user.id, email: session.user.email, name: session.user.name };
}

export async function requireUser(request: Request): Promise<SessionUser> {
  const user = await getSessionUser(request);
  if (!user) {
    const url = new URL(request.url);
    // RR single-fetch keeps its transport URL in loader requests; return to the document, excluding route-selection metadata.
    url.pathname = url.pathname.endsWith("/_.data") ? url.pathname.replace(/_\.data$/, "") : url.pathname.replace(/\.data$/, "");
    if (url.searchParams.has("_routes")) url.searchParams.delete("_routes");
    const preserve = (request.method === "GET" || request.method === "HEAD") && url.pathname !== "/";
    throw redirect(preserve ? readerLoginHref(url.pathname, url.search) : "/login");
  }
  return user;
}

type Member = { user: SessionUser; profile: Profile; db: Db };
export type Reader = Member | { db: Db; user?: never; profile?: never };

// Only explicitly selected reading routes use this gate. Writers stay members-only.
async function getReaderImplementation(request: Request, countPublicRead = true): Promise<Reader> {
  if (!publicReading() || await getSessionUser(request)) return requireMember(request);
  const db = await getDb();
  const rate = countPublicRead ? await hitPublicReadLimit(db, request) : null;
  if (rate && !rate.allowed) throw data("Too many reads. Try again later.", { status: 429, headers: { ...rateLimitHeaders(rate), "X-Robots-Tag": "noindex" } });
  return { db };
}

// For members-only screens (users who completed registration). Send logged-out users to login and users still registering to registration. getActiveMember (members.server.ts) decides.
async function requireMemberImplementation(request: Request): Promise<Member> {
  const user = await requireUser(request);
  const db = await getDb();
  const profile = await getActiveMember(db, user.id);
  if (!profile) throw redirect("/onboarding");
  if (request.method === "GET" && trialParticipationRequired() && needsTrialConsent(profile)) {
    const url = new URL(request.url);
    url.pathname = url.pathname.endsWith("/_.data") ? url.pathname.replace(/_\.data$/, "") : url.pathname.replace(/\.data$/, "");
    url.searchParams.delete("_routes");
    // Keep account controls, personal deletion and appeals reachable before agreement.
    const selfService = /^\/(?:settings(?:\/|$)|appeal\/|notifications(?:\/|$)|following$|suspended$|invites\/new$|mcp\/consent$|u\/|t\/[1-9]\d*$|v\/[^/]+\/chat$)/.test(url.pathname)
      || /^\/[tc]\/[1-9]\d*\/history(?:\/(?:current|[1-9]\d*))?$/.test(url.pathname);
    const resource = ["/mentions/suggest", "/navigation-header"].includes(url.pathname);
    if (!selfService && !resource) throw redirect(`/onboarding?${new URLSearchParams({ next: url.pathname + url.search })}`);
  }
  if (request.method === "GET" || request.method === "HEAD") {
    const rate = await hitBrowserReadLimit(db, request, user.id);
    if (!rate.allowed) throw data("Too many reads. Try again later.", { status: 429, headers: rateLimitHeaders(rate) });
  }
  // Insert operators (addresses in OPERATOR_EMAILS) into roles for queries and records. Determine operator status from the environment variable on every request.
  await ensureOperatorRow(db, user);
  return { user, profile, db };
}

// Entry point for writes (posts, replies, edits, drafts, reactions, reports, mistranslation reports, token creation, invitations, and moderation actions). Call at the start of an action instead of requireMember.
// Send users still registering to registration and suspended users to the suspension explanation (/suspended). getWriter (members.server.ts) decides.
// (Suspended members may still delete their own entries: requireMember in the action in app/routes/topic.tsx.)
async function requireWriterImplementation(request: Request): Promise<Member> {
  const member = await requireMember(request);
  const writer = await getWriter(member.db, member.user.id, { profile: member.profile });
  if (!writer.ok) {
    switch (writer.reason) {
      case "not_a_member": throw redirect("/onboarding");
      case "suspended": throw redirect("/suspended");
      case "trial_consent_required":
      case "trial_restricted": throw redirect("/onboarding");
    }
  }
  return member;
}

// For operator-only screens and operations (addresses in OPERATOR_EMAILS; getModScope in roles.server.ts). Send logged-out users to login.
// Return 404 for non-operator members, including suspended members, to avoid revealing the screen. Suspended operators go to /suspended, as at other write entry points
// (operators cannot be suspended through the UI, but a suspended member could later be added to OPERATOR_EMAILS).
export async function requireOperator(request: Request): Promise<{ user: SessionUser; profile: Profile; db: Db }> {
  const member = await requireMember(request);
  if (!(await getMemberScope(request)).operator) throw data("Not found", { status: 404 });
  await requireWriter(request);
  return member;
}

// For screens and moderation actions restricted to moderators (with assigned languages) or operators. Return 404 for other members to avoid revealing the screen.
// scope is the assigned area (all languages for operators). As at write entry points, send suspended users to /suspended; they cannot take moderation actions while suspended.
export async function requireModerator(request: Request): Promise<Member & { scope: ModScope }> {
  const member = await requireMember(request);
  const scope = await getMemberScope(request);
  if (!isModerator(scope)) throw data("Not found", { status: 404 });
  await requireWriter(request);
  return { ...member, scope };
}

// Cache promises before awaiting them: parent and child loaders start concurrently.
// Weak keys bound both successful and rejected resolutions to this HTTP request.
function perRequest<T>(resolve: (request: Request) => Promise<T>, memberId?: (value: T) => string | undefined) {
  const values = new WeakMap<Request, Promise<T>>();
  return async (request: Request): Promise<T> => {
    let value = values.get(request);
    if (!value) { value = resolve(request); values.set(request, value); }
    const result = await value;
    // Loader render scopes are separate even when they share this Request.
    // Cache database work, but attach identity to every consuming scope.
    const member = memberId?.(result);
    if (member !== undefined) setMarkdownMember(member);
    return result;
  };
}
export const getSessionUser = perRequest(getSessionUserImplementation, user => user?.id);
// Whether this request's session is recent enough to add a credential (CREDENTIAL_FRESH_MS).
export async function getCredentialSessionFresh(request: Request): Promise<boolean> {
  return (await getSessionUser(request)) !== null && isCredentialSessionFresh(sessionCreatedAt.get(request));
}
export const requireMember = perRequest(requireMemberImplementation, member => member.user.id);
export const getReader = perRequest(getReaderImplementation, reader => reader.user?.id);
// Translation browser POSTs enforce their own call and pair limits. They retain
// this gate's public/private and membership checks without consuming page reads.
export const getTranslationReader = perRequest(request => getReaderImplementation(request, false), reader => reader.user?.id);
export const requireWriter = perRequest(requireWriterImplementation, member => member.user.id);
export const getMemberScope = perRequest(async request => {
  const { db, user } = await requireMember(request);
  return getModScope(db, user);
});
export const getRequestViewer = perRequest(async request => {
  const { user } = await requireMember(request);
  return { userId: user.id, scope: await getMemberScope(request) };
}, viewer => viewer.userId);
