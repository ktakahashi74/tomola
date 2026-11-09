import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { entries, profiles, rateLimits, stanceChanges, stances } from "~/lib/db/schema";
import { createReply, createTopic, softDeleteEntry } from "~/lib/entries.server";
import { MEMBER_RATE_LIMITS } from "~/lib/rate-limit.server";
import { pickDistribution, readPeekParam, readStanceMessage, skipRevalidationFor, stanceReturnTo, peekHrefFor, type DistributionView } from "~/lib/stance-ui";
import { setStance } from "~/lib/stances.server";
import { setVote } from "~/lib/votes.server";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

// UI entry points for one-click stances, POST /stance, and personal history, /settings/stances. Fetcher/JavaScript responses are JSON; ordinary forms without JavaScript redirect to the return destination.
const t = (minutes: number) => new Date(Date.UTC(2026, 9, 5, 0, minutes));
const FETCH = { "sec-fetch-dest": "empty" };
const NAVIGATE = { "sec-fetch-dest": "document" };

let h: RouteHarness;
beforeAll(async () => {
  h = await setupRouteHarness();
  await h.signIn("hana", { homeArea: "ja" });
  await h.signIn("ann", { homeArea: "ja" });
  await h.signIn("bob", { homeArea: "en", readLangs: ["en", "ja"] });
  await h.signIn("halfway", { profile: false });
});
afterAll(() => h.restore());

const question = async (title = "経路の問い") => {
  const res = await createTopic(h.db, h.ids.hana, { lang: "ja", title, body: "命題です。", asksStance: true }, { now: t(0) });
  if (!res.ok) throw new Error("question failed");
  return res.id;
};
const send = async (as: string | undefined, form: Record<string, string>, opts: { headers?: Record<string, string> } = {}) => {
  const mod = await import("~/routes/stance");
  return h.outcome(() => mod.action(h.args(h.request("/stance", { as, form, headers: { ...FETCH, ...opts.headers } }))));
};
const body = (r: { value?: unknown }) => (r.value as { data: Record<string, unknown> }).data;
const rowsOf = (userId: string, q: number) => h.db.select().from(stances).where(and(eq(stances.userId, userId), eq(stances.questionId, q)));

describe("POST /stance (fetcher)", () => {
  it("registers, changes and withdraws a stance with the version of the screen, and answers with the stance, the version and the distribution", async () => {
    const q = await question();
    const first = await send("ann", { questionId: String(q), position: "agree", version: "0" });
    expect(first.status).toBe(200);
    expect(body(first)).toMatchObject({ ok: true, questionId: q, position: "agree", version: 1, distribution: { questionId: q, total: 1, counts: { agree: 1, disagree: 0, neither: 0 }, langs: 1 } });
    expect(Object.keys(body(first).distribution as object).sort()).toEqual(["asOf", "counts", "langs", "questionId", "total"]);
    expect(typeof (body(first).distribution as { asOf: unknown }).asOf).toBe("string");
    // the server time of the response, never earlier than the distribution it carries (pickDistribution compares it with a later loader read)
    const at = body(first).at as string;
    expect(new Date(at).toISOString()).toBe(at);
    expect(Date.parse(at)).toBeGreaterThanOrEqual(Date.parse((body(first).distribution as { asOf: string }).asOf));
    const second = await send("ann", { questionId: String(q), position: "disagree", version: "1" });
    expect(body(second)).toMatchObject({ ok: true, position: "disagree", version: 2, distribution: { counts: { agree: 0, disagree: 1, neither: 0 } } });
    // Resubmitting the same value, a double click, is not a conflict.
    expect(body(await send("ann", { questionId: String(q), position: "disagree", version: "1" }))).toMatchObject({ ok: true, position: "disagree", version: 2 });
    // Withdrawal returns no distribution because the user has no selection again.
    const withdrawn = await send("ann", { questionId: String(q), position: "none", version: "2" });
    expect(body(withdrawn)).toEqual({ ok: true, questionId: q, position: null, version: 3, distribution: null, at: expect.any(String) });
    expect(await rowsOf(h.ids.ann, q)).toEqual([]);
    // Responses must not enter shared caches.
    const res = withdrawn.value as { init?: { headers?: Record<string, string> } };
    expect(res.init?.headers?.["Cache-Control"]).toBe("private, no-store");
  });

  it("answers a stale screen with 409 and the current stance, version and distribution, and writes nothing", async () => {
    const q = await question();
    await send("ann", { questionId: String(q), position: "agree", version: "0" });
    await send("ann", { questionId: String(q), position: "neither", version: "1" });
    const stale = await send("ann", { questionId: String(q), position: "disagree", version: "1" });
    expect(stale.status).toBe(409);
    expect(body(stale)).toMatchObject({ ok: false, error: "conflict", questionId: q, position: "neither", version: 2, distribution: { total: 1, counts: { agree: 0, disagree: 0, neither: 1 } } });
    expect(typeof body(stale).at).toBe("string");
    expect(await h.db.select().from(stanceChanges).where(and(eq(stanceChanges.userId, h.ids.ann), eq(stanceChanges.questionId, q)))).toHaveLength(2);
  });

  it("refuses bad input with 400, a question that is not there or not a question with 404, and a hidden question for a new stance with 404", async () => {
    const q = await question();
    const plain = await createTopic(h.db, h.ids.hana, { lang: "ja", title: "ふつう", body: "本文" });
    if (!plain.ok) throw new Error("topic failed");
    const badForms: Array<Record<string, string>> = [
      { questionId: "abc", position: "agree", version: "0" },
      { questionId: String(q), position: "maybe", version: "0" },
      { questionId: String(q), position: "agree", version: "-1" },
      { questionId: String(q), position: "agree" },
      { questionId: "0", position: "agree", version: "0" },
      {},
    ];
    for (const form of badForms) {
      const r = await send("ann", form);
      expect(r.status, JSON.stringify(form)).toBe(400);
      expect(body(r)).toEqual({ ok: false, error: "bad_request" });
    }
    expect((await send("ann", { questionId: "987654", position: "agree", version: "0" })).status).toBe(404);
    expect(body(await send("ann", { questionId: String(plain.id), position: "agree", version: "0" }))).toEqual({ ok: false, error: "not_a_question" });
    // A hidden question cannot receive a new stance; return 404.
    await h.db.update(entries).set({ hiddenAt: t(5) }).where(eq(entries.id, q));
    expect(body(await send("ann", { questionId: String(q), position: "agree", version: "0" }))).toEqual({ ok: false, error: "hidden" });
    expect(await rowsOf(h.ids.ann, q)).toEqual([]);
  });

  it("is a write: visitors go to the login, a user mid-signup to onboarding, a suspended member to /suspended, and a post from another origin is 403", async () => {
    const q = await question();
    const form = { questionId: String(q), position: "agree", version: "0" };
    expect(await send(undefined, form)).toMatchObject({ status: 302, location: "/login" });
    expect(await send("halfway", form)).toMatchObject({ status: 302, location: "/onboarding" });
    await h.db.update(profiles).set({ suspendedUntil: new Date(Date.UTC(2031, 0, 1)), suspendedReason: "spam" }).where(eq(profiles.userId, h.ids.bob));
    try {
      expect(await send("bob", form)).toMatchObject({ status: 302, location: "/suspended" });
    } finally {
      await h.db.update(profiles).set({ suspendedUntil: null, suspendedReason: null }).where(eq(profiles.userId, h.ids.bob));
    }
    expect((await send("ann", form, { headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect(await h.db.select().from(stances).where(eq(stances.questionId, q))).toEqual([]);
  });

  it("limits sends: 30 an hour per member and 10 a day per question (429 with Retry-After; refused and repeated sends count too), and writes nothing when refused", async () => {
    const q = await question();
    const other = await question("もう一つの問い");
    const form = { questionId: String(q), position: "agree", version: "0" };
    // Per-question limit: ten submissions to the same question, counting repeated values. The eleventh returns 429.
    for (let i = 1; i <= 10; i++) expect((await send("bob", form)).status, `send ${i}`).toBe(200);
    const refused = await send("bob", form);
    expect(refused.status).toBe(429);
    expect(body(refused)).toEqual({ ok: false, error: "rate_limited" });
    const headers = (refused.value as { init: { headers: Record<string, string> } }).init.headers;
    expect(Number(headers["Retry-After"])).toBeGreaterThan(0);
    expect(headers["X-RateLimit-Limit"]).toBe("10");
    expect(await rowsOf(h.ids.bob, q)).toMatchObject([{ position: "agree", version: 1 }]);
    // Other questions still accept submissions. The per-member limit of 30/hour also counts rejected submissions.
    expect((await send("bob", { questionId: String(other), position: "neither", version: "0" })).status).toBe(200);
    const key = `member:stance:${h.ids.bob}`;
    const [counter] = await h.db.select().from(rateLimits).where(eq(rateLimits.key, key));
    expect(counter.count).toBe(12);
    await h.db.update(rateLimits).set({ count: MEMBER_RATE_LIMITS.stance.limit }).where(eq(rateLimits.key, key));
    const memberLimited = await send("bob", { questionId: String(other), position: "agree", version: "1" });
    expect(memberLimited.status).toBe(429);
    expect((await rowsOf(h.ids.bob, other))[0].position).toBe("neither");
  });
});

describe("POST /stance (a plain form, without JavaScript)", () => {
  it("goes back to the page: the choice is saved and the browser is sent to returnTo; a conflict and a limit come back with ?stance_msg= and the question, which the loaders read", async () => {
    const q = await question();
    const back = `/latest?asks=1#q-${q}`;
    const ok = await send("ann", { questionId: String(q), position: "agree", version: "0", returnTo: back }, { headers: NAVIGATE });
    expect(ok).toMatchObject({ status: 302, location: back });
    expect((await rowsOf(h.ids.ann, q))[0].position).toBe("agree");
    const stale = await send("ann", { questionId: String(q), position: "disagree", version: "0", returnTo: back }, { headers: NAVIGATE });
    expect(stale.status).toBe(302);
    expect(stale.location).toBe(`/latest?asks=1&stance_msg=conflict&stance_q=${q}#q-${q}`);
    expect(readStanceMessage(new URL(stale.location!, "http://x"))).toEqual({ message: "conflict", questionId: q });
    // Do not use external return destinations; allow only paths within the same site.
    const evil = await send("ann", { questionId: String(q), position: "agree", version: "1", returnTo: "https://evil.example/x" }, { headers: NAVIGATE });
    expect(evil).toMatchObject({ status: 302, location: "/" });
    // Rate limit.
    const limited = await question("上限の問い");
    for (let i = 0; i < 10; i++) await send("bob", { questionId: String(limited), position: "agree", version: "0" });
    const refused = await send("bob", { questionId: String(limited), position: "agree", version: "0", returnTo: "/latest" }, { headers: NAVIGATE });
    expect(refused.location).toBe(`/latest?stance_msg=rate_limited&stance_q=${limited}`);
    // A missing question returns 404.
    expect((await send("ann", { questionId: "987654", position: "agree", version: "0" }, { headers: NAVIGATE })).status).toBe(404);
  });
});

describe("the helpers of the screens", () => {
  it("read ?peek=, ?stance_msg= and decide which submissions do not reload the page", () => {
    expect(readPeekParam(new URL("http://x/latest?peek=12"))).toBe(12);
    for (const bad of ["0", "-1", "1e2", "abc", "", "12abc", "99999999999999999"]) expect(readPeekParam(new URL(`http://x/latest?peek=${bad}`)), bad).toBeNull();
    expect(readPeekParam(new URL("http://x/latest"))).toBeNull();
    expect(readStanceMessage(new URL("http://x/?stance_msg=conflict&stance_q=5"))).toEqual({ message: "conflict", questionId: 5 });
    expect(readStanceMessage(new URL("http://x/?stance_msg=boom&stance_q=5"))).toBeNull();
    expect(readStanceMessage(new URL("http://x/?stance_msg=conflict"))).toBeNull();
    // /stance and /vote: the controls that post there show their own result, so a list does not reload. Other submissions (a reply, a report) reload.
    expect(skipRevalidationFor("/stance")).toBe(true);
    expect(skipRevalidationFor("/stance?x=1")).toBe(true);
    expect(skipRevalidationFor("/vote")).toBe(true);
    expect(skipRevalidationFor("/vote?x=1#y")).toBe(true);
    for (const other of [undefined, "/t/12", "/stances", "/votes", "/settings/stances", "/vote/1"]) expect(skipRevalidationFor(other), String(other)).toBe(false);
    // Return destinations and the "先に結果を見る" link retain the current filter and remove the previous submission result.
    expect(stanceReturnTo("/latest", "?asks=1&page=2&stance_msg=conflict&stance_q=5&peek=5", "q-5")).toBe("/latest?asks=1&page=2#q-5");
    expect(peekHrefFor("/latest", "?asks=1&stance_msg=conflict&stance_q=5", 7, "q-7")).toBe("/latest?asks=1&peek=7#q-7");
    expect(peekHrefFor("/t/12", "", 1, "stance")).toBe("/t/12?peek=1#stance");
  });
});

describe("pickDistribution (which distribution the stance panel shows)", () => {
  const view = (asOf: string, agree: number): DistributionView => ({ questionId: 1, total: agree, counts: { agree, disagree: 0, neither: 0 }, langs: 1, asOf });
  const T1 = "2026-10-05T00:01:00.000Z";
  const T2 = "2026-10-05T00:02:00.000Z";
  const T3 = "2026-10-05T00:03:00.000Z";

  it("withdrawn and the member did not peek: nothing (the link to the results is shown)", () => {
    expect(pickDistribution({ at: T2, distribution: null }, null)).toBeNull();
    // an older read by the loader (the member peeked before choosing) does not bring the numbers back after a withdrawal
    expect(pickDistribution({ at: T2, distribution: null }, view(T1, 3))).toBeNull();
  });

  it("withdrawn, then the member followed 'see the results first': the loader's distribution, which is newer than the response", () => {
    expect(pickDistribution({ at: T2, distribution: null }, view(T3, 3))).toEqual(view(T3, 3));
  });

  it("just chose: the response's distribution (the loader has none, or an older one)", () => {
    expect(pickDistribution({ at: T2, distribution: view(T2, 4) }, null)).toEqual(view(T2, 4));
    expect(pickDistribution({ at: T2, distribution: view(T2, 4) }, view(T1, 3))).toEqual(view(T2, 4));
  });

  it("the page was loaded again after the response: the loader's newer distribution; without a response, the loader's", () => {
    expect(pickDistribution({ at: T2, distribution: view(T2, 4) }, view(T3, 5))).toEqual(view(T3, 5));
    expect(pickDistribution(null, view(T1, 3))).toEqual(view(T1, 3));
    expect(pickDistribution(null, null)).toBeNull();
  });
});

describe("/settings/stances", () => {
  const load = async (as: string) => {
    const mod = await import("~/routes/settings-stances");
    return (await mod.loader(h.args(h.request("/settings/stances", { as })))) as { records: Array<{ questionId: number; position: string | null; changes: Array<{ from: string | null; to: string | null; trigger: { entryId: number; href: string | null } | null }> }>; deleted: boolean };
  };
  const post = async (as: string | undefined, form: Record<string, string>, headers: Record<string, string> = {}) => {
    const mod = await import("~/routes/settings-stances");
    return h.outcome(() => mod.action(h.args(h.request("/settings/stances", { as, form, headers }))));
  };

  it("shows the member's own records only, with the history in time order and the trigger of a change", async () => {
    const q = await question("履歴の問い");
    const reply = await createReply(h.db, h.ids.bob, q, { lang: "en", body: "A point." }, { now: t(1) });
    if (!reply.ok) throw new Error("reply failed");
    await setStance(h.db, h.ids.ann, { questionId: q, position: "agree", expectedVersion: 0 }, { now: t(2) });
    await setVote(h.db, h.ids.ann, reply.id, true, { now: t(3) });
    await setStance(h.db, h.ids.ann, { questionId: q, position: "disagree", expectedVersion: 1, triggerEntryId: reply.id }, { now: t(4) });
    await setStance(h.db, h.ids.bob, { questionId: q, position: "neither", expectedVersion: 0 }, { now: t(5) });
    const mine = (await load("ann")).records.find((r) => r.questionId === q);
    expect(mine).toMatchObject({ position: "disagree" });
    expect(mine?.changes.map((c) => [c.from, c.to])).toEqual([[null, "agree"], ["agree", "disagree"]]);
    expect(mine?.changes[1].trigger).toEqual({ entryId: reply.id, href: `/t/${q}#c-${reply.id}` });
    // bob's history is visible only to bob. ann's data contains neither bob's stance nor member ID.
    const text = JSON.stringify(await load("ann"));
    expect(text).not.toContain(h.ids.bob);
    expect(JSON.stringify(mine)).not.toContain("neither");
    expect((await load("bob")).records.find((r) => r.questionId === q)?.position).toBe("neither");
    const mod = await import("~/routes/settings-stances");
    expect((mod.headers as () => Record<string, string>)()["Cache-Control"]).toBe("private, no-store");
  });

  it("deletes the record of one question with a confirmation, takes the member out of the distribution at once, and a suspended member can delete too", async () => {
    const q = await question("消す記録の問い");
    const other = await question("残す記録の問い");
    await setStance(h.db, h.ids.ann, { questionId: q, position: "agree", expectedVersion: 0 }, { now: t(2) });
    await setStance(h.db, h.ids.ann, { questionId: other, position: "agree", expectedVersion: 0 }, { now: t(2) });
    // Do not delete without confirmation.
    const noConfirm = await post("ann", { intent: "delete", questionId: String(q) });
    expect(noConfirm.status).toBe(400);
    expect(await rowsOf(h.ids.ann, q)).toHaveLength(1);
    expect((await post("ann", { intent: "delete", questionId: "abc", confirm: "1" })).status).toBe(400);
    expect((await post("ann", { intent: "other", questionId: String(q), confirm: "1" })).status).toBe(400);
    // Deletion remains allowed while suspended; this uses the valid-member gate, not the write gate.
    await h.db.update(profiles).set({ suspendedUntil: new Date(Date.UTC(2031, 0, 1)), suspendedReason: "spam" }).where(eq(profiles.userId, h.ids.ann));
    try {
      expect(await post("ann", { intent: "delete", questionId: String(q), confirm: "1" })).toMatchObject({ status: 302, location: "/settings/stances?deleted=1" });
    } finally {
      await h.db.update(profiles).set({ suspendedUntil: null, suspendedReason: null }).where(eq(profiles.userId, h.ids.ann));
    }
    expect(await rowsOf(h.ids.ann, q)).toEqual([]);
    expect(await h.db.select().from(stanceChanges).where(and(eq(stanceChanges.userId, h.ids.ann), eq(stanceChanges.questionId, q)))).toEqual([]);
    expect(await rowsOf(h.ids.ann, other)).toHaveLength(1);
    // History for deleted or hidden questions can also be deleted.
    await softDeleteEntry(h.db, other, { now: t(9) });
    expect(await post("ann", { intent: "delete", questionId: String(other), confirm: "1" })).toMatchObject({ status: 302 });
    expect(await rowsOf(h.ids.ann, other)).toEqual([]);
    // Check same-origin first. Visitors and users still onboarding cannot enter.
    expect((await post("ann", { intent: "delete", questionId: String(q), confirm: "1" }, { origin: "https://evil.example" })).status).toBe(403);
    expect(await post(undefined, { intent: "delete", questionId: String(q), confirm: "1" })).toMatchObject({ status: 302, location: "/login" });
    expect(await post("halfway", { intent: "delete", questionId: String(q), confirm: "1" })).toMatchObject({ status: 302, location: "/onboarding" });
  });
});
