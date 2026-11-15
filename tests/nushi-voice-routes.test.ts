import { afterEach, expect, it, vi } from "vitest";
import { nushiFixture } from "./helpers/nushi";
import { getProfile } from "~/lib/profiles.server";
import { setNushiVoice } from "~/lib/nushi-voice.server";

const auth = vi.hoisted(() => ({ getReader: vi.fn(), requireWriter: vi.fn() }));
vi.mock("~/lib/auth/session.server", () => ({ getReader: auth.getReader, requireWriter: auth.requireWriter }));
import { loader as villageLoader, action as villageAction } from "~/routes/village";
import { loader as personalLoader, action as personalAction } from "~/routes/personal-village-voice";

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
const request = (path: string, form?: Record<string, string>, origin = "http://localhost:5173") => new Request(`http://localhost${path}`, form ? { method: "POST", headers: { Origin: origin }, body: new URLSearchParams(form) } : undefined);

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
  const view = await personalLoader(args);
  expect(view).toMatchObject({ owner: false, operator: false, setting: null, reported: null, voice: { text: "", history: [] } });
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
  auth.requireWriter.mockResolvedValue({ db: f.db, user: { id: "nushi-caller" }, profile: await getProfile(f.db, "nushi-caller") });
  const blocked = await action({ params, request: request(path, { intent: "nushi-voice", voice: "Warm." }) } as never);
  expect(blocked).toMatchObject({ init: { status: 403 } });
  await expect(action({ params, request: request(path, { intent: "nushi-voice", voice: "Warm." }, "https://elsewhere.example") } as never)).rejects.toMatchObject({ init: { status: 403 } });
  auth.requireWriter.mockResolvedValue({ db: f.db, user: { id: "nushi-owner" }, profile: await getProfile(f.db, "nushi-owner") });
  expect(await action({ params, request: request(path, { intent: "nushi-voice", voice: "a".repeat(501) }) } as never)).toMatchObject({ data: { error: "invalid_voice" }, init: { status: 400 } });
  await expect(action({ params, request: request(path, { intent: "nushi-voice", voice: "Warm." }) } as never)).rejects.toMatchObject({ status: 302 });
  await expect(action({ params, request: request(path, { intent: "nushi-voice-clear" }) } as never)).rejects.toMatchObject({ status: 302 });
});
