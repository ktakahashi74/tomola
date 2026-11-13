import { createElement } from "react";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import { renderInRouter } from "./helpers/render-in-router";
import Village, { action, loader } from "~/routes/village";
import VillageChat, { loader as chatLoader } from "~/routes/village-chat";
import { ensureLanguageVillages, villageBySlug } from "~/lib/villages.server";
import { createVillage, endVillage, villageManagement } from "~/lib/village-management.server";
import { entries, profiles, villageInvites, villageMembers, villages, user } from "~/lib/db/schema";
import { createReply, createTopic } from "~/lib/entries.server";
import { serveVillageMd, villageMdMiddleware } from "~/lib/md/twin.server";
import { createApiToken } from "~/lib/tokens.server";
import { createAuth } from "~/lib/auth/auth.server";
import { loader as memberPage } from "~/routes/member-page";
import { handleMcpRequest, handlePublicMcpRequest } from "~/lib/mcp/server.server";
import { villageWriters } from "~/lib/village-writers.server";
import { m } from "~/paraglide/messages.js";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));
let h: RouteHarness;
beforeAll(async () => {
  vi.stubEnv("VILLAGES", "1"); vi.stubEnv("VILLAGE_CHAT", "1"); vi.stubEnv("PUBLIC_READING", "1"); vi.stubEnv("ENABLED_LANGS", "en,ja");
  h = await setupRouteHarness(); await ensureLanguageVillages(h.db);
  for (const name of ["vr_owner", "vr_reader", "vr_rosteronly", "vr_writer", "vr_hidden", "vr_deleted", "vr_reply"]) await h.signIn(name, { homeArea: "en" });
  await h.db.update(profiles).set({ displayName: "Roster Sentinel", displayNameLatin: "Roster Sentinel" }).where(eq(profiles.userId, h.ids.vr_rosteronly));
  await createVillage(h.db, h.ids.vr_owner, { slug: "roster-fixture", name: "Roster fixture", kind: "invite_public", description: "" });
  const village = (await villageBySlug(h.db, "roster-fixture"))!;
  await h.db.insert(villageMembers).values({ villageId: village.id, userId: h.ids.vr_rosteronly });
}, 60000);
afterAll(() => { h.restore(); vi.unstubAllEnvs(); });
const load = (as?: string, suffix = "", slug = "roster-fixture") => loader(h.args(h.request(`/v/${slug}${suffix}`, { as }), { slug }));
const post = (as: string, form: Record<string, string>, slug = "roster-fixture") => h.outcome(() => action(h.args(h.request(`/v/${slug}`, { as, form }), { slug })));
const html = (page: Awaited<ReturnType<typeof load>>, path = "/v/roster-fixture") => renderInRouter(() => createElement(Village, { loaderData: page } as never), path);

it("shows a bounded named roster to nonjoining members, with no management controls or removal permission", async () => {
  const page = await load("vr_reader");
  expect(page.membership?.joined).toBe(false);
  expect(page.management.roster).toContainEqual(expect.objectContaining({ handle: "vr_rosteronly", name: "Roster Sentinel", role: "member" }));
  const rendered = await html(page);
  expect(rendered).toContain('id="village-roster"'); expect(rendered).toContain("Roster Sentinel");
  expect(rendered).not.toContain('id="village-management"');
  expect(rendered).not.toContain('value="remove-member"'); expect(rendered).not.toContain('value="invite-owner"');
  expect(await post("vr_reader", { intent: "remove-member", handle: "vr_rosteronly" })).toMatchObject({ status: 403 });
  expect(await post("vr_owner", { intent: "add-member", handle: "vr_reader" })).toMatchObject({ status: 400 });
});

it("does not fetch language rosters, including for operators, and retains ended shared rosters", async () => {
  vi.stubEnv("OPERATOR_EMAILS", "vr_reader@example.com");
  for (const as of ["vr_owner", "vr_reader"]) {
    const query = vi.spyOn(h.db, "select");
    const page = await load(as, "", "en");
    expect(page.management.canReadRoster).toBe(false); expect(page.management.roster).toEqual([]);
    expect(query.mock.calls.some(([columns]) => columns && "self" in columns && "role" in columns)).toBe(false);
    query.mockRestore();
    expect(await html(page)).not.toContain('id="village-roster"');
  }
  vi.stubEnv("OPERATOR_EMAILS", "");
  await createVillage(h.db, h.ids.vr_owner, { slug: "ended-roster", name: "Ended", kind: "open", description: "" });
  await endVillage(h.db, h.ids.vr_owner, "ended-roster");
  expect((await load("vr_reader", "", "ended-roster")).management.canReadRoster).toBe(true);
  const personal = await h.db.select().from(villages).where(eq(villages.ownerId, h.ids.vr_owner));
  expect((await villageManagement(h.db, personal[0].id, h.ids.vr_reader)).canReadRoster).toBe(false);
});

it("omits roster identities from anonymous HTML/data and every Markdown/text path, including authenticated twins", async () => {
  const anonymous = await load();
  expect(JSON.stringify(anonymous)).not.toContain("vr_rosteronly");
  expect(await html(anonymous)).not.toContain("Roster Sentinel");
  expect(await html(anonymous)).not.toContain('id="village-roster"');
  for (const as of [undefined, "vr_reader", "vr_owner"]) for (const extension of ["md", "txt"]) {
    const request = h.request(`/v/roster-fixture.${extension}`, { as });
    const response = await serveVillageMd(request, "roster-fixture");
    expect(response.status).toBe(200);
    expect(await response.text()).not.toMatch(/vr_rosteronly|Roster Sentinel|roster:/);
    let next = false;
    const twin = await villageMdMiddleware({ request, params: { slug: `roster-fixture.${extension}` } } as never, async () => { next = true; return new Response(); });
    expect(next).toBe(false); expect(await twin.text()).not.toContain("vr_rosteronly");
  }
  const response = await handlePublicMcpRequest(new Request("http://localhost:5173/mcp/public", {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "tomola_latest", arguments: {} } }),
  }), { db: h.db, baseURL: "http://localhost:5173" });
  expect(response.status).toBe(200); expect(await response.text()).not.toMatch(/vr_rosteronly|Roster Sentinel|roster:/);
  const token = await createApiToken(h.db, h.ids.vr_reader, { kind: "read", name: "Roster read fixture" });
  if (!token.ok) throw new Error("Read fixture token failed");
  const api = await serveVillageMd(new Request("http://localhost:5173/v/roster-fixture.md", { headers: { authorization: `Bearer ${token.token}` } }), "roster-fixture");
  expect(api.status).toBe(200); expect(await api.text()).not.toMatch(/vr_rosteronly|Roster Sentinel|roster:/);
  const memberResponse = await handleMcpRequest(new Request("http://localhost:5173/mcp", {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token.token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "tomola_latest", arguments: {} } }),
  }), { db: h.db, auth: createAuth(h.db, { baseURL: "http://localhost:5173", secret: "fictional-roster-test-secret-0123456789", sendMagicLink: async () => {} }), baseURL: "http://localhost:5173" });
  expect(memberResponse.status).toBe(200);
  const memberBody = await memberResponse.text();
  expect(memberBody).toContain('"content"'); expect(memberBody).not.toContain('"isError":true');
  expect(memberBody).not.toMatch(/vr_rosteronly|Roster Sentinel|roster:/);
  const profile = await memberPage(h.args(h.request("/u/vr_rosteronly", { as: "vr_reader" }), { handle: "vr_rosteronly" }));
  expect(JSON.stringify(profile)).not.toContain("roster-fixture");
  vi.stubEnv("PUBLIC_READING", "");
  expect(await h.outcome(() => load())).toMatchObject({ status: 302 });
  vi.stubEnv("PUBLIC_READING", "1");
});

it("invites without adding and reports successful edits, invitations, cancellations and removals in server-rendered status lines", async () => {
  expect(await html(await load("vr_owner"), "/v/roster-fixture?notice=__proto__")).not.toContain('role="status"');
  const sent = await post("vr_owner", { intent: "invite", handle: "vr_reader" });
  expect(sent).toMatchObject({ status: 302 }); expect(sent.location).toContain("#village-invites");
  const page = await load("vr_owner"); expect(page.management.roster.some(row => row.handle === "vr_reader")).toBe(false);
  const [pending] = await h.db.select().from(villageInvites).where(eq(villageInvites.userId, h.ids.vr_reader));
  expect(pending.state).toBe("pending");
  let rendered = await html(await load("vr_owner"), sent.location!);
  expect(rendered).toContain(`role="status">${m.village_invite_sent()}`);
  expect(rendered).toMatch(/id="village-management"[^>]*open=""/);
  const cancelled = await post("vr_owner", { intent: "cancel-invite", invite: pending.id });
  rendered = await html(await load("vr_owner"), cancelled.location!);
  expect(rendered).toContain(`role="status">${m.village_invite_cancelled()}`);
  const edited = await post("vr_owner", { intent: "edit", name: "Roster fixture", description: "Saved description" });
  expect(await html(await load("vr_owner"), edited.location!)).toContain(`role="status">${m.village_saved()}`);
  const removed = await post("vr_owner", { intent: "remove-member", handle: "vr_rosteronly", reason: "" });
  rendered = await html(await load("vr_owner"), removed.location!);
  expect(rendered).toContain(`role="status">${m.village_member_removed()}`);
  // Pagination opens the native details element in the HTML response as well.
  expect(await html(await load("vr_owner", "?membersPage=1"), "/v/roster-fixture?membersPage=1")).toMatch(/id="village-roster"[^>]*open=""/);
  await h.db.insert(villageMembers).values({ villageId: (await villageBySlug(h.db, "roster-fixture"))!.id, userId: h.ids.vr_rosteronly });
  expect((await post("vr_reader", { intent: "accept-invite", invite: pending.id })).status).toBe(404);
  expect(await post("vr_owner", { intent: "invite", handle: "vr_reply" })).toMatchObject({ status: 302 });
  const [invite] = await h.db.select().from(villageInvites).where(eq(villageInvites.userId, h.ids.vr_reply));
  expect(await post("vr_reply", { intent: "accept-invite", invite: invite.id })).toMatchObject({ status: 302 });
  expect((await load("vr_reply")).membership?.joined).toBe(true);
});

it("shows only visible topic authors, once each, in latest-topic order without counts, also to guests", async () => {
  const village = (await villageBySlug(h.db, "roster-fixture"))!;
  for (const handle of ["vr_writer", "vr_hidden", "vr_deleted"]) await h.db.insert(villageMembers).values({ villageId: village.id, userId: h.ids[handle] });
  const topic = async (author: string) => {
    const result = await createTopic(h.db, h.ids[author], { body: "A topic in the authors fixture.", lang: "en", village: village.slug });
    if (!result.ok) throw new Error(result.error); return result.id;
  };
  const first = await topic("vr_writer"), hidden = await topic("vr_hidden"), deleted = await topic("vr_deleted");
  await topic("vr_owner"); await topic("vr_writer");
  await createReply(h.db, h.ids.vr_reply, first, { body: "A reply only.", lang: "en" });
  await h.db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, hidden));
  await h.db.update(entries).set({ deletedAt: new Date() }).where(eq(entries.id, deleted));
  const writers = await villageWriters(h.db, village.id);
  expect(writers.map(row => row.handle)).toEqual(["vr_writer", "vr_owner"]);
  expect(writers.every(row => Object.keys(row).sort().join(",") === "handle,name")).toBe(true);
  const guest = await load(); expect(guest.writers).toEqual(writers);
  const rendered = await html(guest);
  expect(rendered).toContain(m.village_writers());
  expect(rendered).not.toContain('id="village-roster"');
  expect((await load("vr_reader")).writers).toEqual(writers);
});

it("uses the village membership count in chat, linking only non-language audiences to the roster", async () => {
  for (const slug of ["roster-fixture", "en"]) {
    const page = await chatLoader(h.args(h.request(`/v/${slug}/chat`, { as: "vr_owner" }), { slug }));
    const village = (await villageBySlug(h.db, slug))!;
    const members = await h.db.select().from(villageMembers).where(eq(villageMembers.villageId, village.id));
    if ("data" in page) throw new Error("Chat fixture is unavailable");
    expect(page.readers).toBe(members.length);
    const rendered = await renderInRouter(() => createElement(VillageChat, { loaderData: page } as never));
    expect(rendered).toContain(m.village_chat_readers({ count: members.length }));
    expect(rendered.includes(`#village-roster`)).toBe(slug !== "en");
  }
});

it("bounds public authorship to twenty recent distinct authors independently of membership", async () => {
  await createVillage(h.db, h.ids.vr_writer, { slug: "bounded-writers", name: "Bounded writers", kind: "open", description: "" });
  const village = (await villageBySlug(h.db, "bounded-writers"))!;
  const handles = Array.from({ length: 22 }, (_, n) => `vr_bounded_${String(n).padStart(2, "0")}`);
  await h.db.insert(user).values(handles.map(id => ({ id, name: "", email: `${id}@example.com`, emailVerified: true })));
  await h.db.insert(profiles).values(handles.map(id => ({ userId: id, handle: id, handleKey: id, homeArea: "en", readLangs: ["en"] })));
  await h.db.insert(entries).values(handles.map((id, n) => ({ authorId: id, kind: "topic", lang: "en", body: "A historical public fixture.", villageId: village.id, createdAt: new Date(Date.UTC(2001, 0, n + 1)) })));
  expect((await villageWriters(h.db, village.id)).map(writer => writer.handle)).toEqual(handles.slice(2).reverse());
});
