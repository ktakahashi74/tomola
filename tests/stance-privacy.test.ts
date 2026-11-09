import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drafts, stanceChanges, stances } from "~/lib/db/schema";
import { buildMemberExport, buildObservationExport } from "~/lib/exports.server";
import { createReply, createTopic } from "~/lib/entries.server";
import { grantModerator } from "~/lib/roles.server";
import { signOpenInAiToken } from "~/lib/open-in-ai.server";
import { setStance } from "~/lib/stances.server";
import { createApiToken } from "~/lib/tokens.server";
import { setVote } from "~/lib/votes.server";
import { getMd } from "./helpers/md";
import { BASE, setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

// Stances are anonymous: no output reveals who chose which stance except to that person. Only the browser /stance route writes stances. Registration and changes affect neither timestamps nor ordering.
const t = (minutes: number) => new Date(Date.UTC(2026, 9, 5, 0, minutes));

let h: RouteHarness;
const savedOperators = process.env.OPERATOR_EMAILS;
let q: number;
let reply: number;
let alpha: string;
let beta: string;

// Stance voters A (alpha_priv) and B (beta_priv) never post. Their names cannot appear as authors, so any appearance in output would leak stance information.
// Viewers: C, a member; jamod, the assigned moderator; and opal, the operator. hana authored the question.
beforeAll(async () => {
  process.env.OPERATOR_EMAILS = "operator-priv@example.com";
  h = await setupRouteHarness();
  await h.signIn("hana", { homeArea: "ja", readLangs: ["ja", "en"] });
  alpha = await h.signIn("alpha_priv", { homeArea: "ja" });
  beta = await h.signIn("beta_priv", { homeArea: "en", readLangs: ["en", "ja"] });
  await h.signIn("carol", { homeArea: "fr", readLangs: ["fr", "ja"] });
  await h.signIn("jamod", { homeArea: "ja" });
  await h.signIn("opal", { homeArea: "ja", email: "operator-priv@example.com" });
  expect((await grantModerator(h.db, h.ids.opal, h.ids.jamod, "ja")).ok).toBe(true);
  const question = await createTopic(h.db, h.ids.hana, { lang: "ja", title: "共生は制御の代替になりうる", body: "命題です。", asksStance: true }, { now: t(0) });
  if (!question.ok) throw new Error("question failed");
  q = question.id;
  const r = await createReply(h.db, h.ids.hana, q, { lang: "ja", body: "補足です。", stanceTag: "agree" }, { now: t(1) });
  if (!r.ok) throw new Error("reply failed");
  reply = r.id;
  expect((await setStance(h.db, alpha, { questionId: q, position: "agree", expectedVersion: 0 }, { now: t(5) })).ok).toBe(true);
  expect((await setStance(h.db, beta, { questionId: q, position: "disagree", expectedVersion: 0 }, { now: t(6) })).ok).toBe(true);
});
afterAll(() => {
  h.restore();
  if (savedOperators === undefined) delete process.env.OPERATOR_EMAILS;
  else process.env.OPERATOR_EMAILS = savedOperators;
});

const WATCHERS = ["carol", "jamod", "opal"] as const;
const load = async (name: "topic" | "latest" | "home" | "area" | "notifications" | "topic-objections" | "mod-appeals" | "admin-metrics", as: string, path: string, params: Record<string, string> = {}) => {
  const mod = (await import(`../app/routes/${name}.tsx`)) as { loader: (a: never) => unknown };
  return JSON.stringify(await mod.loader(h.args(h.request(path, { as }), params)));
};
const mdText = async (as: string, path: string) => {
  const res = await getMd(h, path, { as });
  expect(res.status, `${as} ${path}`).toBe(200);
  return res.text();
};
const feed = async (as: string, path: string) => {
  const mod = (await import(path.startsWith("/changes") ? "~/routes/changes-md" : "~/routes/manifest")) as { loader: (a: never) => unknown };
  const res = (await mod.loader(h.args(h.request(path, { as })))) as Response;
  expect(res.status, `${as} ${path}`).toBe(200);
  return res.text();
};

describe("nobody but the member sees who chose which stance", () => {
  it("is in no output for another member, a moderator or an operator: not the user id, not the display name, not a stance row", async () => {
    const secrets = [alpha, beta, "alpha_priv", "beta_priv"];
    for (const as of WATCHERS) {
      const outputs: Array<[string, string]> = [
        ["topic page", await load("topic", as, `/t/${q}?peek=1`, { id: String(q) })],
        ["latest", await load("latest", as, `/latest?peek=${q}`)],
        ["home", await load("home", as, `/?peek=${q}`)],
        ["area", await load("area", as, `/a/ja?peek=${q}`, { lang: "ja" })],
        ["thread md", await mdText(as, `/t/${q}.md`)],
        ["stances md", await mdText(as, `/t/${q}/stances.md`)],
        ["stances txt", await mdText(as, `/t/${q}/stances.txt`)],
        ["latest md", await mdText(as, "/latest.md")],
        ["home md", await mdText(as, "/home.md")],
        ["area md", await mdText(as, "/a/ja.md")],
        ["changes", await feed(as, "/changes.md?since=2026-01-01T00:00:00Z")],
        ["manifest", await feed(as, "/manifest.json")],
        ["search", await mdText(as, "/search.md?q=symbiosis")],
      ];
      for (const [name, text] of outputs) for (const secret of secrets) expect(text, `${as}: ${name}`).not.toContain(secret);
    }
    // Exports: operator observation exports and another member's export.
    const observed = JSON.stringify(await buildObservationExport(h.db, { model: null, now: t(60), salt: Buffer.alloc(32, 7) }));
    const carolExport = JSON.stringify(await buildMemberExport(h.db, h.ids.carol, { now: t(60) }));
    for (const secret of secrets) {
      expect(observed, "observation export").not.toContain(secret);
      expect(carolExport, "member export of another member").not.toContain(secret);
    }
// Observation exports omit the fields for individual stance rows (stances and stance_changes). Another member's export has fields for their own stances (empty for carol, who has chosen none), without A's or B's rows.
    expect(observed).not.toMatch(/stance_changes|"stances"|from_position|to_position|trigger_entry/);
    const carolOwn = JSON.parse(carolExport) as { stances: unknown[]; stance_changes: unknown[]; insightful: unknown[] };
    expect([carolOwn.stances, carolOwn.stance_changes]).toEqual([[], []]);
    expect(carolExport).not.toMatch(/from_position":"|to_position":"|trigger_entry_id":\d/);
  });

  it("is in no page of the notifications, the objections, the moderators' appeals or the operator metrics either: not the user id, not the display name, not a stance row", async () => {
    // A question made before the clock of the test, so that the operator metrics (which read up to the current time) have the stances of A and B in them
    const early = await createTopic(h.db, h.ids.hana, { lang: "ja", title: "もう一つの命題", body: "命題です。", asksStance: true }, { now: new Date("2026-09-29T00:00:00Z") });
    if (!early.ok) throw new Error("question failed");
    const objection = await createReply(h.db, h.ids.hana, early.id, { lang: "ja", body: "異議です。", stanceTag: "objection" }, { now: new Date("2026-09-29T00:30:00Z") });
    if (!objection.ok) throw new Error("reply failed");
    expect((await setStance(h.db, alpha, { questionId: early.id, position: "agree", expectedVersion: 0 }, { now: new Date("2026-09-29T01:00:00Z") })).ok).toBe(true);
    expect((await setStance(h.db, beta, { questionId: early.id, position: "disagree", expectedVersion: 0 }, { now: new Date("2026-09-29T02:00:00Z") })).ok).toBe(true);
    expect((await setVote(h.db, alpha, objection.id, true, { now: new Date("2026-09-29T03:00:00Z") })).ok).toBe(true);
    expect((await setStance(h.db, alpha, { questionId: early.id, position: "disagree", expectedVersion: 1, triggerEntryId: objection.id }, { now: new Date("2026-09-29T04:00:00Z") })).ok).toBe(true);
    const secrets = [alpha, beta, "alpha_priv", "beta_priv"];
    const stanceRows = /stance_changes|"stances"|from_position|to_position|trigger_entry|stancesByQuestion/;
    const read = async (name: Parameters<typeof load>[0], as: string, path: string, params: Record<string, string> = {}) => {
      const out = await h.outcome(async () => {
        const mod = (await import(`../app/routes/${name}.tsx`)) as { loader: (a: never) => unknown };
        return (await mod.loader(h.args(h.request(path, { as }), params)));
      });
      return out.status === 200 ? JSON.stringify(out.value) : null;
    };
    let metricsSeen = false;
    for (const as of WATCHERS) {
      const pages: Array<[string, string | null]> = [
        ["notifications", await read("notifications", as, "/notifications")],
        ["objections of the first question", await read("topic-objections", as, `/t/${q}/objections`, { id: String(q) })],
        ["objections of the second question", await read("topic-objections", as, `/t/${early.id}/objections`, { id: String(early.id) })],
        ["moderators' appeals", await read("mod-appeals", as, "/mod/appeals")],
        ["operator metrics", await read("admin-metrics", as, "/admin/metrics")],
      ];
      // the member pages answer 200 for everyone; the moderators' pages and the metrics only for those who may see them
      expect(pages[0][1], `${as}: notifications`).not.toBeNull();
      expect(pages[1][1], `${as}: objections`).not.toBeNull();
      if (as === "carol") expect([pages[3][1], pages[4][1]], "a plain member gets neither the appeals nor the metrics").toEqual([null, null]);
      if (as === "jamod") expect([pages[3][1] !== null, pages[4][1]], "a moderator reviews the appeals, not the metrics").toEqual([true, null]);
      if (as === "opal") {
        expect(pages[3][1], "the operator reviews the appeals").not.toBeNull();
        // the operator metrics hold the first stances of A and B (ja agree, en disagree), summed across questions, and no one's identity
        const metrics = JSON.parse(pages[4][1]!) as { firstStances: Array<{ area: string; counts: Record<string, { numerator: number }> }> };
        expect(metrics.firstStances.find((r) => r.area === "ja")?.counts.agree.numerator).toBe(1);
        expect(metrics.firstStances.find((r) => r.area === "en")?.counts.disagree.numerator).toBe(1);
        metricsSeen = true;
      }
      for (const [name, text] of pages) {
        if (text === null) continue;
        for (const secret of secrets) expect(text, `${as}: ${name}`).not.toContain(secret);
        expect(text, `${as}: ${name}`).not.toMatch(stanceRows);
      }
    }
    expect(metricsSeen).toBe(true);
  });

  it("is in the member export of the member only: A's export has A's own rows (the stances and the history), never B's, and the other way round", async () => {
    const [a, b] = [await buildMemberExport(h.db, alpha, { now: t(60) }), await buildMemberExport(h.db, beta, { now: t(60) })];
    expect(a.stances.map((x) => [x.question_id, x.position])).toContainEqual([q, "agree"]);
    expect(b.stances.map((x) => [x.question_id, x.position])).toContainEqual([q, "disagree"]);
    // each export has the member's own rows only: the area and the position of the other member's row are not there as a row of this export
    for (const [mine, other] of [[a, beta], [b, alpha]] as const) expect(JSON.stringify(mine), "another member's id").not.toContain(other);
    expect(JSON.stringify(a)).not.toContain("beta_priv");
    expect(JSON.stringify(b)).not.toContain("alpha_priv");
  });

  it("is in the page data of the member only: the page of A shows A's stance, never B's, and the page of C shows none", async () => {
    const page = async (as: string) => JSON.parse(await load("topic", as, `/t/${q}`, { id: String(q) })) as { question: { stance: { stance: { position: string | null; version: number } } } };
    expect((await page("alpha_priv")).question.stance.stance).toEqual({ position: "agree", version: 1 });
    expect((await page("beta_priv")).question.stance.stance).toEqual({ position: "disagree", version: 1 });
    for (const as of WATCHERS) expect((await page(as)).question.stance.stance, as).toEqual({ position: null, version: 0 });
    // The same applies to lists.
    const list = async (as: string) => (JSON.parse(await load("latest", as, "/latest")) as { topics: Array<{ id: number; stance?: { position: string | null } }> }).topics.find((x) => x.id === q);
    expect((await list("alpha_priv"))?.stance?.position).toBe("agree");
    expect((await list("carol"))?.stance?.position).toBeNull();
  });
});

describe("the API cannot write a stance (only the browser's /stance can)", () => {
  it("refuses /stance with only a read token, a draft token or ?k= (the session cookie is the only credential), and writes no row", async () => {
    const read = await createApiToken(h.db, h.ids.carol, { name: "reader", kind: "read" });
    const draft = await createApiToken(h.db, h.ids.carol, { name: "drafter", kind: "draft" });
    if (!read.ok || !draft.ok) throw new Error("token failed");
    const before = (await h.db.select().from(stances)).length;
    const mod = await import("~/routes/stance");
    const form = new URLSearchParams({ questionId: String(q), position: "agree", version: "0" });
    for (const [name, headers, url] of [
      ["read token", { authorization: `Bearer ${read.token}` }, "/stance"],
      ["draft token", { authorization: `Bearer ${draft.token}` }, "/stance"],
      ["?k=", {}, `/stance?k=${read.token}`],
    ] as const) {
      const request = new Request(`${BASE}${url}`, { method: "POST", headers: { origin: BASE, "sec-fetch-dest": "empty", ...headers }, body: form });
      const out = await h.outcome(() => mod.action(h.args(request)));
      expect(out, name).toMatchObject({ status: 302, location: "/login" });
    }
    expect((await h.db.select().from(stances)).length).toBe(before);
    expect(await h.db.select().from(stanceChanges).where(eq(stanceChanges.userId, h.ids.carol))).toEqual([]);
  });

  it("makes no stance from a stance-like key in the frontmatter of POST /api/drafts: the draft is made, the key is ignored", async () => {
    const draft = await createApiToken(h.db, h.ids.carol, { name: "drafter2", kind: "draft" });
    if (!draft.ok) throw new Error("token failed");
    const { action } = await import("~/routes/api.drafts");
    const before = (await h.db.select().from(stances)).length;
    for (const key of ["stance: agree", `stance: { question: p-${q}, position: agree }`, `stances: [agree]`, `position: agree\nquestion: p-${q}`, "agree: true"]) {
      const request = new Request(`${BASE}/api/drafts`, {
        method: "POST",
        headers: { authorization: `Bearer ${draft.token}`, "content-type": "text/markdown" },
        body: `---\ntype: topic\ntitle: Frontmatter test\nlang: en\n${key}\n---\nBody.`,
      });
      const res = (await action({ request, params: {}, context: {} } as never)) as Response;
      expect(res.status, key).toBe(201);
    }
    expect((await h.db.select().from(drafts).where(eq(drafts.authorId, h.ids.carol))).length).toBeGreaterThan(0);
    expect((await h.db.select().from(stances)).length).toBe(before);
    expect(await h.db.select().from(stanceChanges).where(eq(stanceChanges.userId, h.ids.carol))).toEqual([]);
  });
});

describe("a stance leaves no trace in the times or the order", () => {
  // Exclude fields dependent on creation timestamps from comparison.
  // The signed "open in AI" link (?k=) carries its expiry in whole seconds from the clock of the moment the button is clicked, so two reads that straddle a second boundary differ in the
  // expiry and the signature. The test compares the links apart from those two parts (the user and the key generation stay, so a link for another member would still differ).
  const unsign = (text: string) => text.replace(/\boai2\.(.+?)\.\d+\.(\d+)\.([a-f0-9]{64})\.[A-Za-z0-9_-]{43}/g, "oai2.$1.<expires>.$2.$3.<signature>");
  const stable = (text: string) => unsign(text).replace(/^\s*"?(?:generated_at|next_since|as_of)"?: .*$/gm, "");

  it("the comparison ignores the expiry and the signature of a signed link, and nothing else of it: two links issued across a second boundary compare equal, links of two members do not", () => {
    const link = (userId: string, at: string, generation = 0) => `{"mdUrl":"http://localhost/home.md?k=${signOpenInAiToken({ resource: "/home.md", userId, generation, now: new Date(at), secret: "s" })}&page=1"}`;
    const a1 = link("user-a", "2026-10-05T00:00:00.999Z");
    const a2 = link("user-a", "2026-10-05T00:00:01.001Z");
    expect(a1).not.toBe(a2);
    expect(unsign(a1)).toBe(unsign(a2));
    expect(unsign(a1)).not.toBe(unsign(link("user-b", "2026-10-05T00:00:00.999Z")));
    expect(unsign(a1)).not.toBe(unsign(link("user-a", "2026-10-05T00:00:00.999Z", 1)));
  });

  it("the first stance, a change, a withdrawal and Insightful on/off leave the manifest, the change feed, the lists and their order as they were", async () => {
    // On another question, register the first stance through withdrawal, comparing before and after to ensure the appearance of other topics and questions remains unchanged.
    const other = await createTopic(h.db, h.ids.hana, { lang: "ja", title: "もう一つの問い", body: "命題です。", asksStance: true }, { now: t(20) });
    const note = await createTopic(h.db, h.ids.hana, { lang: "ja", title: "ふつうの話題", body: "本文です。" }, { now: t(21) });
    if (!other.ok || !note.ok) throw new Error("setup failed");
    const snapshot = async () => ({
      manifest: stable(await feed("carol", "/manifest.json")),
      changes: stable(await feed("carol", "/changes.md?since=2026-01-01T00:00:00Z")),
      latestMd: stable(await mdText("carol", "/latest.md")),
      homeMd: stable(await mdText("carol", "/home.md")),
      threadMd: stable(await mdText("carol", `/t/${other.id}.md`)),
      latest: (JSON.parse(await load("latest", "carol", "/latest")) as { topics: Array<{ id: number; replyCount: number }> }).topics.map((x) => [x.id, x.replyCount]),
      // The cards of the home and of a language list, as the loaders hand them over (their order and what they carry), in both orders and with the questions-only filter.
      home: (JSON.parse(await load("home", "carol", "/")) as { topics: unknown[] }).topics,
      homeActivity: (JSON.parse(await load("home", "carol", "/?order=activity")) as { topics: unknown[] }).topics,
      homeAsks: (JSON.parse(await load("home", "carol", "/?asks=1")) as { topics: unknown[] }).topics,
      area: (JSON.parse(await load("area", "carol", "/a/ja", { lang: "ja" })) as { topics: unknown[] }).topics,
    });
    const before = await snapshot();
    const row = async () => (await h.db.select().from((await import("~/lib/db/schema")).entries).where(eq((await import("~/lib/db/schema")).entries.id, other.id)))[0];
    const times = async () => {
      const r = await row();
      return [r.updatedAt, r.lastActivityAt, r.changedAt].map((d) => d.toISOString());
    };
    const timesBefore = await times();
    // First non-author stance, which starts locking; change; withdrawal; reselection; and adding/removing "なるほど".
    const steps: Array<() => Promise<unknown>> = [
      () => setStance(h.db, alpha, { questionId: other.id, position: "agree", expectedVersion: 0 }, { now: t(40) }),
      () => setStance(h.db, alpha, { questionId: other.id, position: "disagree", expectedVersion: 1 }, { now: t(41) }),
      () => setStance(h.db, alpha, { questionId: other.id, position: null, expectedVersion: 2 }, { now: t(42) }),
      () => setStance(h.db, beta, { questionId: other.id, position: "neither", expectedVersion: 0 }, { now: t(43) }),
      () => setVote(h.db, alpha, other.id, true, { now: t(44) }),
      () => setVote(h.db, alpha, other.id, false, { now: t(45) }),
      () => setVote(h.db, beta, reply, true, { now: t(46) }),
      () => setVote(h.db, beta, reply, false, { now: t(47) }),
    ];
    for (const step of steps) await step();
    // The same holds after adding and withdrawing a stance and deleting one's history; remove beta's stance last.
    await (await import("~/lib/stances.server")).deleteStanceRecord(h.db, beta, other.id);
    await (await import("~/lib/stances.server")).deleteStanceRecord(h.db, alpha, other.id);
    const after = await snapshot();
    // Distributions are a separate resource and absent here, so stance additions/removals do not change these outputs.
    expect(after).toEqual(before);
    expect(await times()).toEqual(timesBefore);
    // No output exposes stance timestamps, including lock time.
    const everything = JSON.stringify(after) + (await load("topic", "carol", `/t/${other.id}`, { id: String(other.id) })) + (await mdText("carol", `/t/${other.id}/stances.md`));
    for (const minute of [40, 41, 42, 43]) expect(everything).not.toContain(t(minute).toISOString().slice(0, 16));
    // The lock time exists on the question row but is absent from page data and Markdown.
    expect((await row()).stanceLockedAt?.toISOString()).toBe(t(40).toISOString());
    expect(everything.toLowerCase()).not.toContain("stancelockedat");
    expect(everything).not.toContain("stance_locked");
  });
});
