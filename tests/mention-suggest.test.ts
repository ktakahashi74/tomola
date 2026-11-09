import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { rateLimits } from "~/lib/db/schema";
import { MEMBER_RATE_LIMITS } from "~/lib/rate-limit.server";
import { addMember } from "./helpers/db";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

// GET /mentions/suggest?q=: the handles for the @mention suggestions. Members only, rate limited, nothing but handles in the answer.
let h: RouteHarness;
let route: typeof import("~/routes/mention-suggest");

beforeAll(async () => {
  h = await setupRouteHarness();
  route = await import("~/routes/mention-suggest");
  await h.signIn("hana", { homeArea: "ja" });
  await h.signIn("halfway", { profile: false });
  for (const handle of ["hanako", "hanabi", "hana_b", "hanac", "har", "ben", "snake_case", "snakexcase", "ab-c"]) await addMember(h.db, `u-${handle}`, handle);
  for (let i = 0; i < 12; i++) await addMember(h.db, `u-many${i}`, `many${String(i).padStart(2, "0")}`);
});
afterAll(() => h.restore());

const ask = async (q: string | null, as: string | null = "hana") => {
  const res = (await route.loader(h.args(h.request(q === null ? "/mentions/suggest" : `/mentions/suggest?q=${encodeURIComponent(q)}`, { as: as ?? undefined })))) as Response;
  return { status: res.status, headers: res.headers, body: await res.json() };
};
const handles = async (q: string) => (await ask(q)).body.handles as string[];

describe("GET /mentions/suggest", () => {
  it("matches the start of the handle key: case and full-width letters do not matter, ascending by key, the member's own handle left out", async () => {
    expect(await handles("hana")).toEqual(["hana_b", "hanabi", "hanac", "hanako"]);
    expect(await handles("HANA")).toEqual(["hana_b", "hanabi", "hanac", "hanako"]);
    expect(await handles("ｈａｎａ")).toEqual(["hana_b", "hanabi", "hanac", "hanako"]);
    expect(await handles("h")).toEqual(["hana_b", "hanabi", "hanac", "hanako", "har"]);
    // The member who asks is not suggested to themselves ("hana" is the asker: it is not listed).
    expect(await handles("hana")).not.toContain("hana");
  });

  it("rejects queries in other scripts", async () => {
    expect(await handles("はな")).toEqual([]);
  });

  it("gives 8 handles at most", async () => {
    const list = await handles("many");
    expect(list).toHaveLength(8);
    expect(list).toEqual(Array.from({ length: 8 }, (_, i) => `many${String(i).padStart(2, "0")}`));
  });

  it("treats _ as a plain character, not as the LIKE wildcard for any one character (a % is not a handle character: the query is refused before the database)", async () => {
    expect(await handles("snake_")).toEqual(["snake_case"]);
    expect(await handles("hana_")).toEqual(["hana_b"]);
    expect(await handles("h_na")).toEqual([]);
    expect(await handles("%")).toEqual([]);
    expect(await handles("ab-")).toEqual(["ab-c"]);
    expect(await handles("a.b")).toEqual([]);
    expect(await handles("a-b")).toEqual([]);
  });

  it("answers an empty list (200) for a query that is not 1 to 30 handle characters", async () => {
    for (const q of ["", "a b", "a%", ".ab", "ha.na", "はな", "-ab", "a".repeat(31), "a/b", "<b>"]) {
      expect(await ask(q), JSON.stringify(q)).toMatchObject({ status: 200, body: { handles: [] } });
    }
    expect(await ask(null)).toMatchObject({ status: 200, body: { handles: [] } });
  });

  it("answers handles and display names without account identifiers", async () => {
    const res = await ask("hana");
    expect(Object.keys(res.body)).toEqual(["handles", "names"]);
    expect(res.body.names.hanako).toEqual({ displayName: null, displayNameLatin: null, label: null });
    expect(res.body.handles.every((v: unknown) => typeof v === "string")).toBe(true);
    // No identifier of a member (ids look like "u-...") in the answer.
    expect(JSON.stringify(res.body)).not.toContain("u-");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("refuses a visitor and a user in the middle of signup with 401, and does not read a bearer token", async () => {
    expect(await ask("hana", null)).toMatchObject({ status: 401, body: { error: "unauthorized" } });
    expect(await ask("hana", "halfway")).toMatchObject({ status: 401 });
    const res = (await route.loader(h.args(new Request("http://localhost:5173/mentions/suggest?q=hana", { headers: { authorization: "Bearer abc", origin: "http://localhost:5173" } })))) as Response;
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("is rate limited per member", async () => {
    const limit = MEMBER_RATE_LIMITS["mention-suggest"];
    expect(limit).toEqual({ limit: 600, windowSeconds: 3600 });
    await h.signIn("busy", { homeArea: "ja" });
    // Fill the window of "busy" up to the limit, then the next request is 429 with the retry headers; "hana" is not affected.
    const key = `member:mention-suggest:${h.ids.busy}`;
    const windowStart = new Date(Math.floor(Date.now() / (limit.windowSeconds * 1000)) * limit.windowSeconds * 1000);
    await h.db.insert(rateLimits).values({ key, windowStart, count: limit.limit, expiresAt: new Date(windowStart.getTime() + limit.windowSeconds * 1000) });
    const refused = await ask("hana", "busy");
    expect(refused).toMatchObject({ status: 429, body: { error: "rate_limited" } });
    expect(refused.headers.get("retry-after")).toBeTruthy();
    expect(refused.headers.get("cache-control")).toBe("private, no-store");
    expect(await ask("hana", "hana")).toMatchObject({ status: 200 });
    await h.db.delete(rateLimits).where(eq(rateLimits.key, key));
  });

  it("names suspended members like anyone else", async () => {
    const { profiles } = await import("~/lib/db/schema");
    await h.db.update(profiles).set({ suspendedUntil: new Date(Date.now() + 86_400_000) }).where(eq(profiles.handle, "ben"));
    expect(await handles("ben")).toEqual(["ben"]);
  });
});
