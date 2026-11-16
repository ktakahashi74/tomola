import { createElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { villages } from "~/lib/db/schema";
import { setTestMessages } from "./stubs/paraglide-messages";
import { renderToStaticMarkup } from "react-dom/server";
import { jsonMessages } from "./helpers/messages-json";
import { m } from "~/paraglide/messages.js";
import { nushiFixture } from "./helpers/nushi";
import { renderInRouter } from "./helpers/render-in-router";
import { getProfile } from "~/lib/profiles.server";
import { personalVoiceVillage, setNushiVoice } from "~/lib/nushi-voice.server";

const auth = vi.hoisted(() => ({ getReader: vi.fn(), requireWriter: vi.fn() }));
vi.mock("~/lib/auth/session.server", () => ({ getReader: auth.getReader, requireWriter: auth.requireWriter }));
import Village, { loader as villageLoader, action as villageAction } from "~/routes/village";
import VillageNushi, { loader as nushiLoader, action as nushiAction } from "~/routes/village-nushi";
import { loader as personalLoader, action as personalAction } from "~/routes/personal-village-voice";

beforeEach(() => setTestMessages(jsonMessages()));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); setTestMessages(); });
const request = (path: string, form?: Record<string, string>, origin = "http://localhost:5173") => new Request(`http://localhost${path}`, form ? { method: "POST", headers: { Origin: origin }, body: new URLSearchParams(form) } : undefined);

it("links to Nushi after posts and pagination, before roster and management, without embedding any style fields", async () => {
  const f = await nushiFixture(); vi.stubEnv("VILLAGE_NUSHI_VOICE", "1");
  auth.getReader.mockResolvedValue({ db: f.db, user: { id: "nushi-owner", email: "owner@example.com" }, profile: await getProfile(f.db, "nushi-owner") });
  const render = async () => {
    const view = await villageLoader({ request: request("/v/nushi-test"), params: { slug: "nushi-test" } } as never);
    return renderInRouter(() => createElement(Village, { loaderData: { ...view, hasNext: true } } as never), "/v/nushi-test");
  };
  const unused = await render();
  expect(unused).not.toContain('id="nushi-voice"');
  expect(unused).not.toContain("data-nushi-voice-setting");
  for (const text of ["", "Polite and brief.", ""]) {
    await setNushiVoice(f.db, "nushi-owner", f.village.id, text);
    const html = await render();
    const link = html.indexOf('href="/v/nushi-test/nushi"');
    expect(link).toBeGreaterThan(html.indexOf(`id="q-${f.source}"`));
    expect(link).toBeGreaterThan(html.indexOf('rel="next"'));
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
    const html = await renderInRouter(() => createElement(VillageNushi, { loaderData: view } as never), "/v/nushi-test/nushi");
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
  const html = await renderInRouter(() => createElement(VillageNushi, { loaderData: view } as never));
  expect(html).toContain('name="target" value="nushi_voice"');
  expect(html).not.toContain('value="information"');
  const listing = await villageLoader(args as never);
  const listingHtml = await renderInRouter(() => createElement(Village, { loaderData: listing } as never));
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
