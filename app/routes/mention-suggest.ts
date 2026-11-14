import { nushiPlace } from "~/lib/nushi-materials.server";
import { nushiInVillage } from "~/lib/nushi-config.server";
import { villageBySlug } from "~/lib/villages.server";
import { personalVillage } from "~/lib/personal-villages.server";
import { m } from "~/paraglide/messages.js";
import { selectDisplayName } from "~/lib/display-names.server";
import { and, asc, ne, sql } from "drizzle-orm";
import type { Route } from "./+types/mention-suggest";
import { requireMember } from "~/lib/auth/session.server";
import { chatConsents, profiles, villageMembers } from "~/lib/db/schema";
import { CHAT_CONSENT_VERSION } from "~/lib/village-chat-consent";
import { villageChatEnabled } from "~/lib/village-chat-enabled.server";
import { chatAccess } from "~/lib/village-chat.server";
import { handleKey } from "~/lib/handles";
import { isMentionQuery } from "~/lib/mention-syntax";
import { hitMemberLimit, rateLimitHeaders } from "~/lib/rate-limit.server";

// The handles for the @mention suggestions in the posting textareas: GET /mentions/suggest?q=<the start of a handle>.
// - Members only, by the session cookie (requireMember; a bearer token and ?k= are not read: this is a screen helper, not an API). Without a session the answer is 401
//   (the textarea ignores it); a user in the middle of signup gets the same.
// - Rate limited per member (MEMBER_RATE_LIMITS "mention-suggest"); 429 with the usual headers.
// - q is 1 to 30 handle characters, the first a letter or a digit; anything else gives an empty list (200). The match is a prefix match on handle_key (NFKC and lower case, so
//   "ＨＡ" and "ha" are the same), 8 handles at most, ascending by handle_key, the member's own handle left out.
// - Suggestions include display names alongside handles, without account IDs. Cache-Control: private, no-store.
// Everybody who is a member can be named, a suspended member included (nobody is special-cased).
const HEADERS = { "Cache-Control": "private, no-store" };
export const MAX_SUGGESTIONS = 8;

// The prefix of a LIKE pattern: the characters that mean something in LIKE are escaped.
const likePrefix = (key: string) => `${key.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export async function loader({ request }: Route.LoaderArgs) {
  let member: Awaited<ReturnType<typeof requireMember>>;
  try {
    member = await requireMember(request);
  } catch (error) {
    // requireMember sends a visitor to the login: a request from a script wants a status.
    if (error instanceof Response && error.status >= 300 && error.status < 400) return Response.json({ error: "unauthorized" }, { status: 401, headers: HEADERS });
    throw error;
  }
  const { user, db } = member;
  const rate = await hitMemberLimit(db, "mention-suggest", user.id);
  if (!rate.allowed) return Response.json({ error: "rate_limited" }, { status: 429, headers: { ...rateLimitHeaders(rate), ...HEADERS } });
  const q = (new URL(request.url).searchParams.get("q") ?? "").normalize("NFKC").toLowerCase();
  if (!isMentionQuery(q)) return Response.json({ handles: [] as string[] }, { headers: HEADERS });
  const slug = villageChatEnabled() ? new URL(request.url).searchParams.get("village") : null;
  const access = slug !== null ? await chatAccess(db, slug, user.id) : null;
  if (slug !== null && !access?.consented) return Response.json({ handles: [] as string[] }, { headers: HEADERS });
  const village = access?.village;
  const rows = await db
    .select({ handle: profiles.handle, displayName: profiles.displayName, displayNameLatin: profiles.displayNameLatin, homeArea: profiles.homeArea })
    .from(profiles)
    .where(and(sql`${profiles.handleKey} LIKE ${likePrefix(handleKey(q))} ESCAPE '\\'`, ne(profiles.userId, user.id), village ? sql`exists (select 1 from ${villageMembers}
      inner join ${chatConsents} on ${chatConsents.villageId} = ${villageMembers.villageId} and ${chatConsents.userId} = ${villageMembers.userId}
        and ${chatConsents.version} = ${CHAT_CONSENT_VERSION}
      where ${villageMembers.villageId} = ${village.id} and ${villageMembers.userId} = ${profiles.userId})` : undefined))
    .orderBy(asc(profiles.handleKey))
    .limit(MAX_SUGGESTIONS);
  const params = new URL(request.url).searchParams;
  let nushi = false;
  if (slug === null && (params.has("thread") || params.has("postVillage")) && ("nushi".startsWith(q) || "village-ai".startsWith(q))) {
    const thread = params.get("thread"), selected = params.get("postVillage");
    if (thread && /^\d+$/.test(thread)) nushi = !!await nushiPlace(db, Number(thread));
    else if (selected === `@${member.profile.handle}`) { const place = await personalVillage(db, user.id); nushi = !!place && nushiInVillage(place); }
    else if (selected) { const place = await villageBySlug(db, selected); nushi = !!place && nushiInVillage(place); }
  }
  const handles = [...(nushi ? ["nushi"] : []), ...rows.map(row => row.handle)].slice(0, MAX_SUGGESTIONS);
  const names = Object.fromEntries(rows.map(row => [row.handle, { displayName: row.displayName, displayNameLatin: row.displayNameLatin, label: selectDisplayName(row) }]));
  if (nushi) names.nushi = { displayName: null, displayNameLatin: null, label: m.nushi_suggestion() };
  return Response.json({ handles, ...(handles.length ? { names } : {}) }, { headers: HEADERS });
}
