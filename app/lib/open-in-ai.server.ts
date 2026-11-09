import { createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { authSecret } from "~/lib/auth/auth.server";
import type { Db } from "~/lib/db/client.server";
import { profiles } from "~/lib/db/schema";
import { isEnabledLang } from "~/lib/enabled-langs.server";
import type { Lang } from "~/lib/languages";
import { mdUrl, siteUrl } from "~/lib/md/urls.server";
import { parsePageParam } from "~/lib/pagination";
import { getActiveMember } from "~/lib/members.server";
import type { Profile } from "~/lib/profiles.server";
import { OPEN_IN_AI_TTL_SECONDS } from "~/lib/open-in-ai";

// Click-issued, five-minute read delegation for one canonical resource. The digest
// binds the path and its query, including language, page and filters. Never issue
// credentials from HTML loaders or carry them into links in a Markdown response.
// Format: oai2.<userId>.<expiry>.<generation>.<resource digest>.<HMAC>.
// The old, seven-day oai1 format is deliberately rejected, including after upgrades.
export const OPEN_IN_AI_PREFIX = "oai2";
export { OPEN_IN_AI_TTL_SECONDS };
// Clock-skew allowance lets another server accept a freshly issued link.
const EXPIRY_SKEW_SECONDS = 60;
const HKDF_INFO = "tomola open-in-ai v2";

// Keep response-affecting query names together; the reader inventory test checks
// these against every parser used by the supported resource paths.
const PAGE_QUERY_KEYS = ["page", "lang", "sentences", "asks", "long", "order"] as const;
export const READ_RESOURCE_QUERY_KEYS = {
  page: PAGE_QUERY_KEYS,
  following: [...PAGE_QUERY_KEYS, "all"],
  search: ["lang", "q"],
  changes: ["since", "cursor"],
  glossary: ["page", "to", "from", "deleted"],
  manifest: ["after"],
  unfiltered: [],
} as const;

function resourceQueryKeys(path: string): readonly string[] | null {
  if (/^\/t\/[1-9]\d*\/stances\.(?:md|txt)$/.test(path) || path === "/glossary.yaml") return READ_RESOURCE_QUERY_KEYS.unfiltered;
  if (/^\/(?:t\/[1-9]\d*|a\/[A-Za-z-]+|latest|home)\.(?:md|txt)$/.test(path)) return READ_RESOURCE_QUERY_KEYS.page;
  if (/^\/following\.(?:md|txt)$/.test(path)) return READ_RESOURCE_QUERY_KEYS.following;
  if (/^\/search\.(?:md|txt)$/.test(path)) return READ_RESOURCE_QUERY_KEYS.search;
  if (/^\/changes\.(?:md|txt)$/.test(path)) return READ_RESOURCE_QUERY_KEYS.changes;
  if (/^\/glossary\.(?:md|txt)$/.test(path)) return READ_RESOURCE_QUERY_KEYS.glossary;
  if (path === "/manifest.json") return READ_RESOURCE_QUERY_KEYS.manifest;
  return null;
}

// .md and .txt are aliases. Parameter order and an explicit page=1 do not change
// a resource; only the reader's query values remain part of the scope. Reject duplicate
// query parameters rather than relying on differing first/last-value parsers.
export function canonicalReadResource(resource: string): string | null {
  if (resource.length > 4096) return null;
  let url: URL;
  try { url = new URL(resource, siteUrl("")); } catch { return null; }
  const queryKeys = resourceQueryKeys(url.pathname);
  if (url.origin !== new URL(siteUrl("")).origin || url.username || url.password || url.hash || queryKeys === null) return null;
  const seen = new Set<string>();
  for (const [key] of url.searchParams) {
    if (seen.has(key)) return null;
    seen.add(key);
  }
  for (const key of seen) if (!queryKeys.includes(key)) url.searchParams.delete(key);
  if (url.searchParams.get("page") === "1") url.searchParams.delete("page");
  url.searchParams.sort();
  const query = url.searchParams.toString();
  return `${url.pathname.replace(/\.txt$/, ".md")}${query ? `?${query}` : ""}`;
}

function resourceDigest(resource: string): string | null {
  const canonical = canonicalReadResource(resource);
  return canonical === null ? null : createHash("sha256").update(siteUrl(canonical)).digest("hex");
}

const keyCache = new Map<string, Buffer>();
function signingKey(secret: string): Buffer {
  let key = keyCache.get(secret);
  if (!key) {
    key = Buffer.from(hkdfSync("sha256", secret, "", HKDF_INFO, 32));
    keyCache.set(secret, key);
  }
  return key;
}

function mac(message: string, secret: string): Buffer {
  return createHmac("sha256", signingKey(secret)).update(message).digest();
}

export function isOpenInAiToken(token: string): boolean {
  return token.startsWith(`${OPEN_IN_AI_PREFIX}.`) || token.startsWith("oai1.");
}

export function signOpenInAiToken(input: { userId: string; generation: number; resource: string; now?: Date; secret?: string }): string {
  const now = input.now ?? new Date();
  const digest = resourceDigest(input.resource);
  if (digest === null) throw new RangeError("Invalid read resource");
  const expires = Math.floor(now.getTime() / 1000) + OPEN_IN_AI_TTL_SECONDS;
  const message = `${OPEN_IN_AI_PREFIX}.${input.userId}.${expires}.${input.generation}.${digest}`;
  return `${message}.${mac(message, input.secret ?? authSecret()).toString("base64url")}`;
}

export type OpenInAiError = "malformed" | "bad_signature" | "expired" | "revoked" | "no_member" | "scope_mismatch";

// Split from the end to permit dots in user IDs. Verify the MAC before checking
// membership, then require the requested resource to match the signed digest.
export async function verifyOpenInAiToken(
  db: Db,
  token: string,
  opts: { resource: string; now?: Date; secret?: string },
): Promise<{ ok: true; userId: string; profile: Profile } | { ok: false; error: OpenInAiError }> {
  if (token.length > 4096) return { ok: false, error: "malformed" };
  const parts = token.split(".");
  if (parts.length < 6 || parts[0] !== OPEN_IN_AI_PREFIX) return { ok: false, error: "malformed" };
  const [signature, digest, generationText, expiresText] = [parts.at(-1)!, parts.at(-2)!, parts.at(-3)!, parts.at(-4)!];
  const userId = parts.slice(1, -4).join(".");
  if (userId === "" || !/^[a-f0-9]{64}$/.test(digest) || !/^\d{1,12}$/.test(expiresText) || !/^\d{1,9}$/.test(generationText)) return { ok: false, error: "malformed" };
  const given = Buffer.from(signature, "base64url");
  // Reject alternate encodings with different trailing bits or extra characters that decode to the same value.
  if (given.toString("base64url") !== signature) return { ok: false, error: "malformed" };
  const expected = mac(token.slice(0, token.length - signature.length - 1), opts.secret ?? authSecret());
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, error: "bad_signature" };
  const nowSeconds = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  if (Number(expiresText) <= nowSeconds) return { ok: false, error: "expired" };
  // Issue expiry now+TTL. Reject farther-future expiry even with valid signature, such as forged extended tokens after key leakage.
  if (Number(expiresText) > nowSeconds + OPEN_IN_AI_TTL_SECONDS + EXPIRY_SKEW_SECONDS) return { ok: false, error: "malformed" };
  if (resourceDigest(opts.resource) !== digest) return { ok: false, error: "scope_mismatch" };
  const profile = await getActiveMember(db, userId);
  if (!profile) return { ok: false, error: "no_member" };
  if (profile.openInAiGeneration !== Number(generationText)) return { ok: false, error: "revoked" };
  return { ok: true, userId, profile };
}

// 「AIで開く用のリンクを無効にする」 increments generation, invalidating previously issued links even within expiry.
export async function revokeOpenInAiLinks(db: Db, userId: string): Promise<boolean> {
  const rows = await db
    .update(profiles)
    .set({ openInAiGeneration: sql`${profiles.openInAiGeneration} + 1` })
    .where(eq(profiles.userId, userId))
    .returning({ userId: profiles.userId });
  return rows.length > 0;
}

export type AiOpenLinks = {
  // Token-free twin path, carrying ?page= and ?lang=. 「Markdownでコピー」 fetches using the session Cookie.
  mdPath: string;
  // Token-free absolute twin URL. The button requests a fresh delegated URL on click.
  mdUrl: string;
};

// Called by loaders showing 「AIで開く」. path is the HTML page path (/t/1042,/latest,/a/ja,/home).
// No delegation is issued during rendering. The click endpoint signs mdPath after
// authenticating the member and checking the browser's origin.
// page selects twin page, default URL ?page=. Lists share screen boundaries; threads count
// deleted replies and may differ. Thread loaders derive it from the screen page's first reply.
// asks carries 「問いだけ」 ?asks=1 to twins; extra carries other filters such as glossary ?to=/from=/deleted=.
export function aiOpenLinks(
  request: Request,
  profile: Pick<Profile, "userId" | "openInAiGeneration"> | null | undefined,
  path: string,
  opts: { now?: Date; secret?: string; page?: number; asks?: boolean; extra?: Record<string, string> } = {},
): AiOpenLinks {
  const params = new URL(request.url).searchParams;
  // ?lang= (the display language of this page only) is carried over to the Markdown twin only when it is an enabled language (ENABLED_LANGS); the twin answers 400 for any other.
  const lang = isEnabledLang(params.get("lang")) ? (params.get("lang") as Lang) : null;
  const carry = { lang, page: opts.page ?? parsePageParam(params.get("page")) ?? 1 };
  // asks: ?asks=1 questions-only list. Omitting would turn filtered page N into unfiltered page N.
  const merged = { ...(opts.asks ? { asks: "1" } : {}), ...opts.extra };
  const extra = Object.keys(merged).length > 0 ? merged : undefined;
  const local = mdUrl(`${path}.md`, { k: null, ...carry, extra });
  return { mdPath: local.slice(siteUrl("").length), mdUrl: local };
}
