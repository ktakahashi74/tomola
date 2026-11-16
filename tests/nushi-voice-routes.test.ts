import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { nushiFixture } from "./helpers/nushi";
import { renderInRouter } from "./helpers/render-in-router";
import { getProfile } from "~/lib/profiles.server";
import { personalVoiceVillage, setNushiVoice } from "~/lib/nushi-voice.server";

const auth = vi.hoisted(() => ({ getReader: vi.fn(), requireWriter: vi.fn() }));
vi.mock("~/lib/auth/session.server", () => ({ getReader: auth.getReader, requireWriter: auth.requireWriter }));
import Village, { loader as villageLoader, action as villageAction } from "~/routes/village";
import { loader as personalLoader, action as personalAction } from "~/routes/personal-village-voice";

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
const request = (path: string, form?: Record<string, string>, origin = "http://localhost:5173") => new Request(`http://localhost${path}`, form ? { method: "POST", headers: { Origin: origin }, body: new URLSearchParams(form) } : undefined);

it("keeps unused styles out of the village page and places published or cleared styles after posts and pagination", async () => {
  const f = await nushiFixture(); vi.stubEnv("VILLAGE_NUSHI_VOICE", "1");
  auth.getReader.mockResolvedValue({ db: f.db, user: { id: "nushi-owner", email: "owner@example.com" }, profile: await getProfile(f.db, "nushi-owner") });
  const render = async () => {
    const view = await villageLoader({ request: request("/v/nushi-test"), params: { slug: "nushi-test" } } as never);
    return renderInRouter(() => createElement(Village, { loaderData: { ...view, hasNext: true } } as never), "/v/nushi-test");
  };
  const unused = await render();
  expect(unused).not.toContain('id="nushi-voice"');
  expect(unused).toContain("data-nushi-voice-setting");
  for (const text of ["Polite and brief.", ""]) {
    await setNushiVoice(f.db, "nushi-owner", f.village.id, text);
    const html = await render();
    const voice = html.indexOf('id="nushi-voice"');
    expect(voice).toBeGreaterThan(html.indexOf(`id="q-${f.source}"`));
    expect(voice).toBeGreaterThan(html.indexOf('rel="next"'));
    expect(voice).toBeLessThan(html.indexOf('id="village-roster"'));
    expect(voice).toBeLessThan(html.indexOf('id="village-management"'));
    expect(html).toContain("data-nushi-voice-text");
  }
});

it("shows styles and only style history to guests and removes all style fields when disabled", async () => {
  const f = await nushiFixture(); vi.stubEnv("VILLAGE_NUSHI_VOICE", "1");
  await setNushiVoice(f.db, "nushi-owner", f.village.id, "Polite and brief.");
  auth.getReader.mockResolvedValue({ db: f.db });
  const args = { request: request("/v/nushi-test"), params: { slug: "nushi-test" } } as never;
  const view = await villageLoader(args);
  expect(view).toMatchObject({ reader: true, voice: { text: "Polite and brief.", history: [{ actor: "znushi_owner", text: "Polite and brief." }] } });
  expect(view.voice?.history[0]).not.toHaveProperty("actorId");
  expect(view.voice?.history[0]).not.toHaveProperty("oldText");
  vi.stubEnv("VILLAGE_NUSHI_VOICE", "0");
  expect(await villageLoader(args)).not.toHaveProperty("voice");
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
  const action = personal ? personalAction : villageAction;
  const params = personal ? { handle: "znushi_owner" } : { slug: "nushi-test" };
  const path = personal ? "/v/personal/znushi_owner" : "/v/nushi-test";
  auth.requireWriter.mockResolvedValue({ db: f.db, user: { id: "nushi-caller", email: "caller@example.com" }, profile: await getProfile(f.db, "nushi-caller") });
  const blocked = await action({ params, request: request(path, { intent: "nushi-voice", voice: "Warm." }) } as never);
  expect(blocked).toMatchObject({ init: { status: 403 } });
  await expect(action({ params, request: request(path, { intent: "nushi-voice", voice: "Warm." }, "https://elsewhere.example") } as never)).rejects.toMatchObject({ init: { status: 403 } });
  auth.requireWriter.mockResolvedValue({ db: f.db, user: { id: "nushi-owner", email: "owner@example.com" }, profile: await getProfile(f.db, "nushi-owner") });
  expect(await action({ params, request: request(path, { intent: "nushi-voice", voice: "a".repeat(501) }) } as never)).toMatchObject({ data: { error: "invalid_voice" }, init: { status: 400 } });
  await expect(action({ params, request: request(path, { intent: "nushi-voice", voice: "Warm." }) } as never)).rejects.toMatchObject({ status: 302 });
  await expect(action({ params, request: request(path, { intent: "nushi-voice-clear" }) } as never)).rejects.toMatchObject({ status: 302 });
});
