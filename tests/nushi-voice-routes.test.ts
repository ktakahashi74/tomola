import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { entries, villages } from "~/lib/db/schema";
import { setTestMessages } from "./stubs/paraglide-messages";
import { renderToStaticMarkup } from "react-dom/server";
import { jsonMessages } from "./helpers/messages-json";
import { m } from "~/paraglide/messages.js";
import { nushiFixture } from "./helpers/nushi";
import { renderInRouter } from "./helpers/render-in-router";
import { getProfile } from "~/lib/profiles.server";
import { personalVoiceVillage, setNushiVoice } from "~/lib/nushi-voice.server";
import { createTopic } from "~/lib/entries.server";
import { READING_BATCH } from "~/lib/reading-page";

const auth = vi.hoisted(() => ({ getReader: vi.fn(), requireWriter: vi.fn(), requireMember: vi.fn() }));
vi.mock("~/lib/auth/session.server", () => ({ getReader: auth.getReader, requireWriter: auth.requireWriter, requireMember: auth.requireMember }));
import Village, { loader as villageLoader, action as villageAction } from "~/routes/village";
import VillageNushi, { loader as nushiLoader, action as nushiAction } from "~/routes/village-nushi";
import { loader as personalLoader, action as personalAction } from "~/routes/personal-village-voice";
import MemberPage, { loader as memberLoader } from "~/routes/member-page";
import { routeElement } from "./helpers/route-fixtures";

beforeEach(() => setTestMessages(jsonMessages()));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); setTestMessages(); });
const request = (path: string, form?: Record<string, string>, origin = "http://localhost:5173") => new Request(`http://localhost${path}`, form ? { method: "POST", headers: { Origin: origin }, body: new URLSearchParams(form) } : undefined);
const seedOlderPosts = (db: Awaited<ReturnType<typeof nushiFixture>>["db"], villageId: string) => db.insert(entries).values(Array.from({ length: READING_BATCH }, () => ({
  kind: "topic", authorId: "nushi-owner", villageId, lang: "en", title: "Older post", body: "An older fixture post.", createdAt: new Date("2026-01-01T00:00:00Z"),
})));

it("links to Nushi after posts and Load more, before roster and management, without embedding any style fields", async () => {
  const f = await nushiFixture(); vi.stubEnv("VILLAGE_NUSHI_VOICE", "1");
  await seedOlderPosts(f.db, f.village.id);
  auth.getReader.mockResolvedValue({ db: f.db, user: { id: "nushi-owner", email: "owner@example.com" }, profile: await getProfile(f.db, "nushi-owner") });
  const render = async () => {
    const view = await villageLoader({ request: request("/v/nushi-test"), params: { slug: "nushi-test" } } as never);
    return renderInRouter(() => routeElement(Village, { loaderData: view }), "/v/nushi-test");
  };
  const unused = await render();
  expect(unused).not.toContain('id="nushi-voice"');
  expect(unused).not.toContain("data-nushi-voice-setting");
  for (const text of ["", "Polite and brief.", ""]) {
    await setNushiVoice(f.db, "nushi-owner", f.village.id, text);
    const html = await render();
    const link = html.indexOf('href="/v/nushi-test/nushi"');
    const post = html.indexOf(`id="q-${f.source}"`);
    const more = html.indexOf("data-load-more");
    expect(post).toBeGreaterThan(-1);
    expect(more).toBeGreaterThan(post);
    expect(link).toBeGreaterThan(more);
    expect(link).toBeLessThan(html.indexOf('id="village-roster"'));
    expect(link).toBeLessThan(html.indexOf('id="village-management"'));
    expect(html).toContain(renderToStaticMarkup(m.village_nushi_title()));
    expect(html).not.toContain('id="nushi-voice"');
    expect(html).not.toContain("data-nushi-voice-setting");
  }
});

it("shows only public style history on the Nushi page and keeps it out of the village payload", async () => {
  const f = await nushiFixture(); vi.stubEnv("VILLAGE_NUSHI_VOICE", "1");
  await setNushiVoice(f.db, "nushi-owner", f.village.id, "Polite and brief.");
  auth.getReader.mockResolvedValue({ db: f.db });
  const args = { request: request("/v/nushi-test/nushi"), params: { slug: "nushi-test" } };
  const view = await nushiLoader(args as never);
  expect(view).toMatchObject({ owner: false, reported: null, voice: { text: "Polite and brief.", history: [{ actor: "znushi_owner", text: "Polite and brief." }] } });
  expect(view.voice?.history[0]).not.toHaveProperty("actorId");
  expect(view.voice?.history[0]).not.toHaveProperty("oldText");
  expect(await villageLoader(args as never)).not.toHaveProperty("voice");
  vi.stubEnv("VILLAGE_NUSHI_VOICE", "0");
  expect(await nushiLoader(args as never)).not.toHaveProperty("voice");
  expect(await villageLoader(args as never)).toHaveProperty("nushiPage", true);
});

it("shows the default style to everyone, settings only to owners, and reports only to other members", async () => {
  const f = await nushiFixture(); vi.stubEnv("VILLAGE_NUSHI_VOICE", "1");
  const args = { request: request("/v/nushi-test/nushi"), params: { slug: "nushi-test" } };
  for (const id of ["nushi-owner", "nushi-caller", undefined]) {
    auth.getReader.mockResolvedValue({ db: f.db, ...(id ? { user: { id, email: `${id}@example.com` }, profile: await getProfile(f.db, id) } : {}) });
    const view = await nushiLoader(args as never);
    const html = await renderInRouter(() => routeElement(VillageNushi, { loaderData: view }), "/v/nushi-test/nushi");
    expect(html).toContain(renderToStaticMarkup(m.village_nushi_title()));
    expect(html).toContain(m.nushi_description());
    expect(html).toContain('href="/ai-use#nushi"');
    expect(html).toContain('href="/v/nushi-test"');
    expect(html).toContain(m.nushi_voice_default());
    expect(html.includes("data-nushi-voice-setting")).toBe(id === "nushi-owner");
  }
  await setNushiVoice(f.db, "nushi-owner", f.village.id, "Brief.");
  auth.getReader.mockResolvedValue({ db: f.db, user: { id: "nushi-caller", email: "caller@example.com" } });
  const view = await nushiLoader(args as never);
  const html = await renderInRouter(() => routeElement(VillageNushi, { loaderData: view }));
  expect(html).toContain('name="target" value="nushi_voice"');
  expect(html).not.toContain('value="information"');
  const listing = await villageLoader(args as never);
  const listingHtml = await renderInRouter(() => routeElement(Village, { loaderData: listing }));
  expect(listingHtml).not.toContain('value="nushi_voice"');
});

it("uses the same availability for links and pages, retaining history after stopping or ending the village", async () => {
  const f = await nushiFixture(); vi.stubEnv("VILLAGE_NUSHI_VOICE", "1");
  auth.getReader.mockResolvedValue({ db: f.db });
  auth.requireWriter.mockResolvedValue({ db: f.db, user: { id: "nushi-owner" } });
  const args = { request: request("/v/nushi-test/nushi"), params: { slug: "nushi-test" } };
  await f.db.update(villages).set({ nushiEnabled: false }).where(eq(villages.id, f.village.id));
  expect(await villageLoader(args as never)).toHaveProperty("nushiPage", false);
  await expect(nushiLoader(args as never)).rejects.toMatchObject({ init: { status: 404 } });
  await expect(nushiAction({ ...args, request: request("/v/nushi-test/nushi", { intent: "nushi-voice", voice: "Brief." }) } as never)).rejects.toMatchObject({ init: { status: 404 } });
  await setNushiVoice(f.db, "nushi-owner", f.village.id, "Brief.");
  await setNushiVoice(f.db, "nushi-owner", f.village.id, "");
  await f.db.update(villages).set({ endedAt: new Date() }).where(eq(villages.id, f.village.id));
  expect(await villageLoader(args as never)).toHaveProperty("nushiPage", true);
  expect(await nushiLoader(args as never)).toMatchObject({ ended: true, voice: { text: "", history: expect.any(Array) } });
  for (const slug of ["missing", "personal"]) await expect(nushiLoader({ ...args, params: { slug } } as never)).rejects.toMatchObject({ init: { status: 404 } });
  vi.stubEnv("VILLAGES", ""); auth.getReader.mockClear();
  await expect(nushiLoader(args as never)).rejects.toMatchObject({ init: { status: 404 } });
  expect(auth.getReader).not.toHaveBeenCalled();
});

it("opens the Nushi page when only chat Nushi is enabled, and not for history alone once styles are off", async () => {
  const f = await nushiFixture(); vi.stubEnv("VILLAGE_NUSHI_VOICE", "1");
  vi.stubEnv("VILLAGE_NUSHI", "0"); vi.stubEnv("VILLAGE_CHAT", "1"); vi.stubEnv("VILLAGE_CHAT_NUSHI", "1");
  auth.getReader.mockResolvedValue({ db: f.db });
  const args = { request: request("/v/nushi-test/nushi"), params: { slug: "nushi-test" } };
  expect(await villageLoader(args as never)).toHaveProperty("nushiPage", true);
  expect(await nushiLoader(args as never)).toMatchObject({ voice: { text: "" } });
  await setNushiVoice(f.db, "nushi-owner", f.village.id, "Brief.");
  vi.stubEnv("VILLAGE_CHAT_NUSHI", "0"); vi.stubEnv("VILLAGE_NUSHI_VOICE", "0");
  expect(await villageLoader(args as never)).toHaveProperty("nushiPage", false);
  await expect(nushiLoader(args as never)).rejects.toMatchObject({ init: { status: 404 } });
});

it("rejects style writes and reports on the village page and non-style reports on the Nushi page", async () => {
  const f = await nushiFixture(); vi.stubEnv("VILLAGE_NUSHI_VOICE", "1");
  auth.requireWriter.mockResolvedValue({ db: f.db, user: { id: "nushi-owner" } });
  const params = { slug: "nushi-test" };
  for (const intent of ["nushi-voice", "nushi-voice-clear", "flag"]) await expect(villageAction({ params, request: request("/v/nushi-test", { intent, target: "nushi_voice", voice: "Brief." }) } as never)).rejects.toMatchObject({ init: { status: 400 } });
  await expect(nushiAction({ params, request: request("/v/nushi-test/nushi", { intent: "flag", target: "information" }) } as never)).rejects.toMatchObject({ init: { status: 400 } });
});

it("exposes only public style information on a personal village page and gates it before authentication when disabled", async () => {
  const f = await nushiFixture(); vi.stubEnv("VILLAGE_NUSHI_VOICE", "1");
  auth.getReader.mockResolvedValue({ db: f.db });
  const args = { request: request("/v/personal/znushi_owner"), params: { handle: "znushi_owner" } } as never;
  await expect(personalLoader(args)).rejects.toMatchObject({ init: { status: 404 } });
  auth.getReader.mockResolvedValue({ db: f.db, user: { id: "nushi-caller", email: "caller@example.com" } });
  await expect(personalLoader(args)).rejects.toMatchObject({ init: { status: 404 } });
  auth.getReader.mockResolvedValue({ db: f.db, user: { id: "nushi-owner", email: "owner@example.com" } });
  expect(await personalLoader(args)).toMatchObject({ owner: true, voice: { history: [] } });
  const village = (await personalVoiceVillage(f.db, "znushi_owner"))!;
  await setNushiVoice(f.db, "nushi-owner", village.id, "A public personal style.");
  await setNushiVoice(f.db, "nushi-owner", village.id, "");
  auth.getReader.mockResolvedValue({ db: f.db });
  const view = await personalLoader(args);
  expect(view).toMatchObject({ owner: false, operator: false, setting: null, reported: null, voice: { text: "", history: expect.any(Array) } });
  expect(view.voice.history).toHaveLength(2);
  expect(view).not.toHaveProperty("userId");
  expect(view).not.toHaveProperty("topics");
  vi.stubEnv("VILLAGE_NUSHI_VOICE", "0"); auth.getReader.mockClear();
  await expect(personalLoader(args)).rejects.toMatchObject({ init: { status: 404 } });
  expect(auth.getReader).not.toHaveBeenCalled();
});

it("links to the personal Nushi after posts and Load more, for the owner or readers with style history", async () => {
  const f = await nushiFixture(); vi.stubEnv("VILLAGE_NUSHI_VOICE", "1");
  const topic = await createTopic(f.db, "nushi-owner", { title: "Personal post", body: "A personal village post.", lang: "en", village: "@znushi_owner" });
  expect(topic.ok).toBe(true);
  const village = (await personalVoiceVillage(f.db, "znushi_owner"))!;
  await seedOlderPosts(f.db, village.id);
  const href = "/v/personal/znushi_owner#nushi-voice";
  const args = { request: request("/u/znushi_owner"), params: { handle: "znushi_owner" } } as never;
  const load = async (id: string) => {
    auth.requireMember.mockResolvedValue({ db: f.db, user: { id }, profile: await getProfile(f.db, id) });
    return memberLoader(args);
  };
  const render = async (id: string, visible: boolean) => {
    const view = await load(id);
    if (visible) expect(view).toHaveProperty("nushiVoiceHref", href);
    else expect(view).not.toHaveProperty("nushiVoiceHref");
    const html = await renderInRouter(() => routeElement(MemberPage, { loaderData: view }), "/u/znushi_owner");
    expect(html.includes(`href="${href}"`)).toBe(visible);
    if (visible) {
      expect(html).toContain(`<a class="link-ui inline-block" href="${href}"`);
      expect(html).toContain(`>${renderToStaticMarkup(m.village_nushi_title())}</a>`);
      const link = html.indexOf(`href="${href}"`);
      const post = html.indexOf("Personal post");
      const more = html.indexOf(`data-load-more="true" href="/u/znushi_owner?vlist_after=${view.personal!.list!.next}#village"`);
      expect(post).toBeGreaterThan(-1);
      expect(more).toBeGreaterThan(post);
      expect(link).toBeGreaterThan(more);
      expect(html).toContain(`>${renderToStaticMarkup(m.list_load_more())}</a>`);
      expect(link).toBeLessThan(html.indexOf('id="posts"'));
    }
  };
  await render("nushi-owner", true);
  await render("nushi-caller", false);
  await setNushiVoice(f.db, "nushi-owner", village.id, "Brief.");
  await render("nushi-caller", true);
  await setNushiVoice(f.db, "nushi-owner", village.id, "");
  await render("nushi-caller", true);
  vi.stubEnv("VILLAGE_NUSHI_VOICE", "0");
  await render("nushi-owner", false);
  await render("nushi-caller", false);
});

it.each([false, true])("enforces writer ownership, length and origin at the action, personal=%s", async personal => {
  const f = await nushiFixture(); vi.stubEnv("VILLAGE_NUSHI_VOICE", "1");
  const action = personal ? personalAction : nushiAction;
  const params = personal ? { handle: "znushi_owner" } : { slug: "nushi-test" };
  const path = personal ? "/v/personal/znushi_owner" : "/v/nushi-test/nushi";
  auth.requireWriter.mockResolvedValue({ db: f.db, user: { id: "nushi-caller", email: "caller@example.com" }, profile: await getProfile(f.db, "nushi-caller") });
  const blocked = await action({ params, request: request(path, { intent: "nushi-voice", voice: "Warm." }) } as never);
  expect(blocked).toMatchObject({ init: { status: 403 } });
  await expect(action({ params, request: request(path, { intent: "nushi-voice", voice: "Warm." }, "https://elsewhere.example") } as never)).rejects.toMatchObject({ init: { status: 403 } });
  auth.requireWriter.mockResolvedValue({ db: f.db, user: { id: "nushi-owner", email: "owner@example.com" }, profile: await getProfile(f.db, "nushi-owner") });
  auth.getReader.mockResolvedValue({ db: f.db, user: { id: "nushi-owner", email: "owner@example.com" }, profile: await getProfile(f.db, "nushi-owner") });
  expect(await action({ params, request: request(path, { intent: "nushi-voice", voice: "a".repeat(501) }) } as never)).toMatchObject({ data: { error: "invalid_voice" }, init: { status: 400 } });
  for (const form of [{ intent: "nushi-voice", voice: "Warm." }, { intent: "nushi-voice-clear" }] as Record<string, string>[]) {
    const response = await action({ params, request: request(path, form) } as never).catch(error => error as Response);
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(302);
    expect((response as Response).headers.get("location")).toBe(`${path}?manage=1#nushi-voice`);
    if (!personal) expect(await nushiLoader({ params, request: request(path) } as never)).toMatchObject({ voice: { text: form.voice ?? "" } });
  }
});
