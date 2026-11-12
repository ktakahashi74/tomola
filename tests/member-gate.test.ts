import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getActiveMember, getWriter } from "~/lib/members.server";
import { requireMember, requireWriter } from "~/lib/auth/session.server";
import { authenticateRead } from "~/lib/api/read-auth.server";
import { handleDraftCreate } from "~/lib/api/drafts-api.server";
import { createApiToken } from "~/lib/tokens.server";
import { createTopic } from "~/lib/entries.server";
import { signOpenInAiToken } from "~/lib/open-in-ai.server";
import { eq } from "drizzle-orm";
import { profiles } from "~/lib/db/schema";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

// The single valid-member predicate in members.server is used by requireMember, read auth, and the draft API.
// requireWriter also checks that the member is not suspended; covered by suspension tests.
let h: RouteHarness;
beforeAll(async () => {
  h = await setupRouteHarness();
  await h.signIn("hana", { homeArea: "ja" });
  await h.signIn("halfway", { profile: false });
  // A former member has a token but no longer has a profile.
  await h.signIn("ex", { homeArea: "ja" });
});
afterAll(() => h.restore());

describe("the active member check", () => {
  it("says who is a member: a profile makes one; a user mid-signup, or nobody, is not", async () => {
    expect(await getActiveMember(h.db, h.ids.hana)).toMatchObject({ userId: h.ids.hana, handle: "hana" });
    expect(await getActiveMember(h.db, h.ids.halfway)).toBeNull();
    expect(await getActiveMember(h.db, "nobody")).toBeNull();
    expect(await getWriter(h.db, h.ids.hana)).toMatchObject({ ok: true, profile: { handle: "hana" } });
    expect(await getWriter(h.db, h.ids.halfway)).toEqual({ ok: false, reason: "not_a_member" });
  });

  it("requireMember and requireWriter send visitors to the login and users mid-signup to onboarding", async () => {
    for (const gate of [requireMember, requireWriter]) {
      expect(await h.outcome(() => gate(h.request("/")))).toMatchObject({ status: 302, location: "/login" });
      expect(await h.outcome(() => gate(h.request("/", { as: "halfway" })))).toMatchObject({ status: 302, location: "/onboarding" });
      const member = await gate(h.request("/", { as: "hana" }));
      expect(member.profile.handle).toBe("hana");
      expect(member.user.id).toBe(h.ids.hana);
    }
  });

  it("the read authentication uses it: tokens, signed links and the session of a user mid-signup are refused", async () => {
    const read = await createApiToken(h.db, h.ids.ex, { name: "t", kind: "read" });
    if (!read.ok) throw new Error("token failed");
    const signedLink = signOpenInAiToken({ resource: "/latest.md", userId: h.ids.ex, generation: 0 });
    await h.db.delete(profiles).where(eq(profiles.userId, h.ids.ex));
    const asToken = await authenticateRead(new Request("http://localhost:5173/latest.md", { headers: { authorization: `Bearer ${read.token}` } }), "text", { db: h.db });
    expect(asToken).toMatchObject({ ok: false, response: { status: 403 } });
    const signed = await authenticateRead(new Request(`http://localhost:5173/latest.md?k=${signedLink}`), "text", { db: h.db });
    expect(signed).toMatchObject({ ok: false, response: { status: 401 } });
    const session = await authenticateRead(h.request("/latest.md", { as: "ex" }), "text", { db: h.db });
    expect(session).toMatchObject({ ok: false, response: { status: 403 } });
    // A member passes.
    const ok = await authenticateRead(h.request("/latest.md", { as: "hana" }), "text", { db: h.db });
    expect(ok).toMatchObject({ ok: true, auth: { userId: h.ids.hana, via: "session" } });
  });

  it("POST /api/drafts uses it: a draft token of a user mid-signup is refused", async () => {
    await h.signIn("ex2", { homeArea: "ja" });
    const draft = await createApiToken(h.db, h.ids.ex2, { name: "d", kind: "draft" });
    if (!draft.ok) throw new Error("token failed");
    await h.db.delete(profiles).where(eq(profiles.userId, h.ids.ex2));
    const res = await handleDraftCreate(
      new Request("http://localhost:5173/api/drafts", { method: "POST", headers: { authorization: `Bearer ${draft.token}`, "content-type": "text/markdown" }, body: "hello" }),
      { db: h.db },
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "not_a_member" });
  });
});

describe("the principles page is public", () => {
  it("/principles and its twins open for a visitor, for a user mid-signup and for a member, with no redirect to the login", async () => {
    const page = await import("~/routes/principles");
    const twin = await import("~/routes/principles-md");
    for (const as of [undefined, "halfway", "hana"]) {
      expect(await h.outcome(async () => (await page.loader(h.args(h.request("/principles", { as }))))), `page as ${as}`).toMatchObject({ status: 200, location: null });
      const res = (await twin.loader(h.args(h.request("/principles.md", { as })))) as Response;
      expect(res.status, `twin as ${as}`).toBe(200);
      expect(res.headers.get("location")).toBeNull();
    }
  });
});

describe("every write path goes through the writer gate", () => {
  it("a user mid-signup is sent to onboarding by each action that writes", async () => {
    const topic = await createTopic(h.db, h.ids.hana, { lang: "ja", title: "t", body: "b" });
    if (!topic.ok) throw new Error("topic failed");
    const id = String(topic.id);
    const cases: Array<[string, () => Promise<Record<string, (a: never) => unknown>>, string, Record<string, string>, Record<string, string>]> = [
      ["member-page (village follow)", () => import("~/routes/member-page") as never, "/u/hana", { handle: "hana" }, { intent: "follow" }],
      // Private reading uses requireMember: suspension limits publishing, not
      // saving readable posts or erasing one's own private saved records.
      ["private saved reading", () => import("~/routes/save") as never, "/save", {}, { topicId: id, saved: "1" }],
      ["private list watermark", () => import("~/routes/list-seen") as never, "/list-seen", {}, { scope: "/", seenAt: "2026-01-01T00:00:00.000Z" }],
      ["topic-new (post, draft)", () => import("~/routes/topic-new") as never, "/t/new", {}, { title: "x", body: "y" }],
      ["draft autosave", () => import("~/routes/draft-autosave") as never, "/drafts/autosave", {}, { body: "y" }],
      ["topic (reply, draft, translation report)", () => import("~/routes/topic") as never, `/t/${id}`, { id }, { body: "y" }],
      ["topic (translation report)", () => import("~/routes/topic") as never, `/t/${id}`, { id }, { intent: "report", entryId: id, lang: "en", field: "body", note: "n" }],
      ["topic (report a post)", () => import("~/routes/topic") as never, `/t/${id}`, { id }, { intent: "flag", entryId: id, reason: "spam" }],
      ["topic (delete own post)", () => import("~/routes/topic") as never, `/t/${id}`, { id }, { intent: "delete", entryId: id, confirm: "1" }],
      ["topic-edit", () => import("~/routes/topic-edit") as never, `/t/${id}/edit`, { id }, { title: "x", body: "y" }],
      ["reply-edit", () => import("~/routes/reply-edit") as never, `/c/${id}/edit`, { id }, { body: "y" }],
      ["draft (save, publish, delete)", () => import("~/routes/draft") as never, "/drafts/1", { id: "1" }, { intent: "save", body: "y" }],
      ["vote", () => import("~/routes/vote") as never, "/vote", {}, { entryId: id, on: "1" }],
      ["stance (choose, change, withdraw)", () => import("~/routes/stance") as never, "/stance", {}, { questionId: id, position: "agree", version: "0" }],
      ["settings-tokens (create)", () => import("~/routes/settings-tokens") as never, "/settings/tokens", {}, { intent: "create", name: "n", kind: "read" }],
      ["invites-new", () => import("~/routes/invites-new") as never, "/invites/new", {}, { email: "x@example.com" }],
    ];
    for (const [name, load, p, params, form] of cases) {
      const mod = await load();
      const outcome = await h.outcome(() => mod.action(h.args(h.request(p, { as: "halfway", form }), params)));
      expect(outcome, name).toMatchObject({ status: 302, location: "/onboarding" });
    }
  });

  // Extract route actions by balancing braces; ignore // comments at line start or after whitespace so their braces do not interfere.
  function actionBodies(source: string): string[] {
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
    const bodies: string[] = [];
    for (const match of code.matchAll(/export\s+(?:async\s+)?function\s+action\b|export\s+const\s+action\b/g)) {
      let i = code.indexOf("(", match.index! + match[0].length - 1);
      if (i === -1) continue;
      // Skip argument parentheses because types can contain braces.
      for (let depth = 0; i < code.length; i++) {
        if (code[i] === "(") depth++;
        else if (code[i] === ")" && --depth === 0) break;
      }
      const open = code.indexOf("{", i);
      let depth = 0;
      let end = open;
      for (; end < code.length; end++) {
        if (code[end] === "{") depth++;
        else if (code[end] === "}" && --depth === 0) break;
      }
      bodies.push(code.slice(open, end + 1));
    }
    return bodies;
  }

  // Route-action coverage lives in the AST lint rule; behavioral member gates above remain.

  it("an action that checks the origin does it first: before any login check, form or body is read", () => {
    const dir = path.join(process.cwd(), "app", "routes");
    const late: string[] = [];
    const checkedFiles: string[] = [];
    let checked = 0;
    for (const file of fs.readdirSync(dir).sort()) {
      if (!/\.(tsx|ts)$/.test(file)) continue;
      for (const body of actionBodies(fs.readFileSync(path.join(dir, file), "utf8"))) {
        const at = body.search(/\bassertSameOrigin\(/);
        if (at === -1) continue;
        checked++;
        checkedFiles.push(file);
        const first = body.search(/\b(?:require\w+|getSessionUser|getAuth|getDb|request\.formData|request\.json|request\.text)\(/);
        if (first !== -1 && first < at) late.push(file);
      }
    }
    expect(checked).toBeGreaterThanOrEqual(7);
    // Stance posting and history deletion check same-origin first; topic edits enter moderator fix_entry handling.
    expect(checkedFiles).toEqual(expect.arrayContaining(["stance.ts", "settings-stances.tsx", "topic-edit.tsx", "follow.ts"]));
    expect(late).toEqual([]);
  });


});
