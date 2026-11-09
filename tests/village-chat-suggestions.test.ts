import { consentChatMembers } from "./helpers/chat-consent";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { chatConsents, rateLimits, villageMembers, villages } from "~/lib/db/schema";
import { CHAT_CONSENT_VERSION } from "~/lib/village-chat-consent";
import { MEMBER_RATE_LIMITS } from "~/lib/rate-limit.server";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import { selectedTables } from "./helpers/query-tables";

const unscopedCandidates = {
  handles: ["vcm_outside", "vcm_target"],
  names: {
    vcm_outside: { displayName: null, displayNameLatin: null, label: null },
    vcm_target: { displayName: null, displayNameLatin: null, label: null },
  },
};
const scopedCandidates = {
  handles: ["vcm_target"],
  names: { vcm_target: { displayName: null, displayNameLatin: null, label: null } },
};

let h: RouteHarness;
let route: typeof import("~/routes/mention-suggest");
beforeAll(async () => {
  h = await setupRouteHarness(); route = await import("~/routes/mention-suggest");
  for (const handle of ["vcm_writer", "vcm_target", "vcm_outside"]) await h.signIn(handle);
  const [village] = await h.db.insert(villages).values({ slug: "suggestion-village", kind: "open" }).returning();
  await h.db.insert(villageMembers).values(["vcm_writer", "vcm_target"].map(handle => ({ villageId: village.id, userId: h.ids[handle] })));
  await consentChatMembers(h.db);
});
afterAll(() => h.restore());
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
async function ask(village?: string, as = "vcm_writer", q = "vcm_") {
  const request = h.request(`/mentions/suggest?q=${q}${village === undefined ? "" : `&village=${village}`}`, { as });
  return await route.loader(h.args(request)) as Response;
}

it("returns no scoped candidates before the requester accepts current consent", async () => {
  vi.stubEnv("VILLAGES", "1"); vi.stubEnv("VILLAGE_CHAT", "1");
  const [village] = await h.db.select().from(villages).where(eq(villages.slug, "suggestion-village"));
  const own = and(eq(chatConsents.villageId, village.id), eq(chatConsents.userId, h.ids.vcm_writer));
  try {
    await h.db.delete(chatConsents).where(own);
    for (const q of ["vcm_", "ＶＣＭ＿"]) {
      const response = await ask("suggestion-village", "vcm_writer", q);
      expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.json()).toEqual({ handles: [] });
    }
    await h.db.insert(chatConsents).values({ villageId: village.id, userId: h.ids.vcm_writer, version: CHAT_CONSENT_VERSION + 1 });
    expect(await (await ask("suggestion-village")).json()).toEqual({ handles: [] });
    expect(await (await ask()).json()).toEqual(unscopedCandidates);
    await h.db.update(chatConsents).set({ version: CHAT_CONSENT_VERSION }).where(own);
    expect(await (await ask("suggestion-village")).json()).toEqual(scopedCandidates);
  } finally { await consentChatMembers(h.db); await h.db.update(chatConsents).set({ version: CHAT_CONSENT_VERSION }).where(own); }
});

it("excludes candidates without current consent in this village while keeping unscoped queries unchanged", async () => {
  vi.stubEnv("VILLAGES", "1"); vi.stubEnv("VILLAGE_CHAT", "1");
  const [village] = await h.db.select().from(villages).where(eq(villages.slug, "suggestion-village"));
  const target = and(eq(chatConsents.villageId, village.id), eq(chatConsents.userId, h.ids.vcm_target));
  const [other] = await h.db.insert(villages).values({ slug: "suggestion-other", kind: "open" }).returning();
  await h.db.insert(villageMembers).values({ villageId: other.id, userId: h.ids.vcm_target });
  await h.db.insert(chatConsents).values({ villageId: other.id, userId: h.ids.vcm_target, version: CHAT_CONSENT_VERSION });
  try {
    await h.db.delete(chatConsents).where(target);
    expect(await (await ask("suggestion-village")).json()).toEqual({ handles: [] });
    expect(await (await ask()).json()).toEqual(unscopedCandidates);
    await h.db.insert(chatConsents).values({ villageId: village.id, userId: h.ids.vcm_target, version: CHAT_CONSENT_VERSION + 1 });
    expect(await (await ask("suggestion-village")).json()).toEqual({ handles: [] });
    await h.db.update(chatConsents).set({ version: CHAT_CONSENT_VERSION }).where(target);
    expect(await (await ask("suggestion-village", "vcm_writer", "ＶＣＭ＿")).json()).toEqual(scopedCandidates);
  } finally { await consentChatMembers(h.db); await h.db.update(chatConsents).set({ version: CHAT_CONSENT_VERSION }).where(target); }
});

it.each([["", ""], ["1", ""]])("ignores village scope and does no village reads when settings are %s/%s", async (villageFlag, chatFlag) => {
  vi.stubEnv("VILLAGES", villageFlag); vi.stubEnv("VILLAGE_CHAT", chatFlag);
  const seen = selectedTables(h.db);
  for (const village of [undefined, "suggestion-village", "missing", ""]) {
    const response = await ask(village);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual(unscopedCandidates);
  }
  expect([...seen.tables]).not.toContain("village_members");
  expect([...seen.tables]).not.toContain("villages");
  seen.restore();
});

it("scopes candidates to current village membership, returns the same empty shape for outsiders and missing villages, and leaves unscoped posting queries unchanged", async () => {
  vi.stubEnv("VILLAGES", "1"); vi.stubEnv("VILLAGE_CHAT", "1");
  expect(await (await ask("suggestion-village")).json()).toEqual(scopedCandidates);
  expect(await (await ask(undefined)).json()).toEqual(unscopedCandidates);
  for (const [village, as] of [["suggestion-village", "vcm_outside"], ["missing", "vcm_writer"], ["", "vcm_writer"]]) {
    expect(await (await ask(village, as)).json()).toEqual({ handles: [] });
  }
  expect(await (await ask("suggestion-village", "vcm_writer", "ＶＣＭ＿")).json()).toEqual(scopedCandidates);
  await h.db.delete(villageMembers).where(eq(villageMembers.userId, h.ids.vcm_target));
  expect(await (await ask("suggestion-village")).json()).toEqual({ handles: [] });
});

it("retains the existing suggestion rate limit for scoped requests, including denied scopes", async () => {
  vi.stubEnv("VILLAGES", "1"); vi.stubEnv("VILLAGE_CHAT", "1");
  const { limit, windowSeconds } = MEMBER_RATE_LIMITS["mention-suggest"];
  const key = `member:mention-suggest:${h.ids.vcm_writer}`;
  const windowStart = new Date(Math.floor(Date.now() / (windowSeconds * 1000)) * windowSeconds * 1000);
  await h.db.delete(rateLimits).where(eq(rateLimits.key, key));
  await h.db.insert(rateLimits).values({ key, windowStart, count: limit, expiresAt: new Date(windowStart.getTime() + windowSeconds * 1000) });
  const response = await ask("missing");
  expect(response.status).toBe(429);
  expect(response.headers.get("retry-after")).not.toBeNull();
  expect(response.headers.get("cache-control")).toBe("private, no-store");
});
