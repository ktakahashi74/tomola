import { afterEach, expect, it, vi } from "vitest";
import { createTestDb, addMember } from "./helpers/db";
import { getProfile } from "~/lib/profiles.server";
import { createTopic } from "~/lib/entries.server";
import { ensureLanguageVillages } from "~/lib/villages.server";
import { villages } from "~/lib/db/schema";

const auth = vi.hoisted(() => ({ reader: null as unknown, readAuth: null as unknown, getReader: vi.fn(), requireWriter: vi.fn() }));
vi.mock("~/lib/auth/session.server", () => ({ getReader: auth.getReader, requireWriter: auth.requireWriter }));
vi.mock("~/lib/api/page-read-auth.server", () => ({ authenticatePageRead: async () => ({ ok: true, auth: auth.readAuth }) }));
import { loader as directoryLoader, action as directoryAction } from "~/routes/villages";
import { loader as headerLoader } from "~/routes/member-layout";
import { loader as directoryMdLoader } from "~/routes/villages-md";
import { loader as villageLoader, action as villageAction } from "~/routes/village";
import { serveVillagesMd, serveVillageMd, villageMdMiddleware } from "~/lib/md/twin.server";
const request = (path: string) => new Request(`http://localhost${path}`);
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

it("returns 404 for every disabled HTML/Markdown route before authentication or village reads", async () => {
  auth.getReader.mockRejectedValue(new Error("must not authenticate"));
  await expect(Promise.resolve().then(() => directoryAction())).rejects.toMatchObject({ init: { status: 404 } });
  await expect(directoryLoader({ request: request("/villages") } as never)).rejects.toMatchObject({ init: { status: 404 } });
  await expect(villageLoader({ request: request("/v/en"), params: { slug: "en" } } as never)).rejects.toMatchObject({ init: { status: 404 } });
  for (const pending of [serveVillagesMd(request("/villages.md")), serveVillageMd(request("/v/en.md"), "en"), directoryMdLoader({ request: request("/villages.txt") })]) await expect(pending).rejects.toMatchObject({ init: { status: 404 } });
  for (const url of ["/villages", "/v/en", "/v/en.md", "/v/en.txt", "/v/en.data"]) await expect(headerLoader({ request: request(url) })).rejects.toMatchObject({ init: { status: 404 } });
  const response = new Response("ordinary route processing");
  const next = vi.fn(async () => response);
  expect(await villageMdMiddleware({ request: request("/v/en.md"), params: { slug: "en.md" } }, next)).toBe(response);
  expect(next).toHaveBeenCalledOnce();
  expect(auth.getReader).not.toHaveBeenCalled();
});

it("shows only active public villages and omits private IDs and membership fields for guests", async () => {
  vi.stubEnv("VILLAGES", "1");
  const db = await createTestDb();
  await ensureLanguageVillages(db, { ENABLED_LANGS: "en,zh-Hans" });
  await db.insert(villages).values([{ kind: "closed", name: "Private", slug: null }, { kind: "invite_public", slug: "invited" }, { kind: "open", slug: "ended", endedAt: new Date() }]);
  auth.getReader.mockResolvedValue({ db });
  auth.readAuth = { db, profile: null, carryK: null, rate: null };
  const directory = await directoryLoader({ request: request("/villages") } as never);
  expect(directory.villages).toHaveLength(3);
  expect(directory.villages.every(v => !("members" in v) && !("id" in v))).toBe(true);
  const village = await villageLoader({ request: request("/v/zh-Hans"), params: { slug: "zh-Hans" } } as never);
  expect(village.village.slug).toBe("zh-hans");
  expect(village.membership).toBeNull();
  expect(village.village).not.toHaveProperty("id");
  expect((await serveVillageMd(request("/v/zh-Hans.md"), "zh-Hans")).status).toBe(200);
  for (const slug of ["ended", "invited"]) expect((await serveVillageMd(request(`/v/${slug}.md`), slug)).status).toBe(200);
  expect((await serveVillageMd(request("/v/absent.md"), "absent")).status).toBe(404);
});

it("keeps membership writes same-origin and rejects missing or unknown intents", async () => {
  vi.stubEnv("VILLAGES", "1");
  const db = await createTestDb();
  await ensureLanguageVillages(db);
  await addMember(db, "alice", "alice");
  const profile = await getProfile(db, "alice");
  auth.requireWriter.mockResolvedValue({ db, user: { id: "alice" }, profile });
  const post = (intent: string, origin = "http://localhost:5173") => new Request("http://localhost/v/en", { method: "POST", headers: { Origin: origin }, body: new URLSearchParams({ intent }) });
  await expect(villageAction({ request: post("join", "https://other.example"), params: { slug: "en" } } as never)).rejects.toMatchObject({ init: { status: 403 } });
  await expect(villageAction({ request: post(""), params: { slug: "en" } } as never)).rejects.toMatchObject({ init: { status: 400 } });
  expect(await villageAction({ request: post("join"), params: { slug: "en" } } as never)).toEqual({ ok: true });
});

it("matches explicit question filters between a village page and its Markdown twin", async () => {
  vi.stubEnv("VILLAGES", "1");
  const db = await createTestDb();
  await ensureLanguageVillages(db);
  await addMember(db, "alice", "alice", { homeArea: "en" });
  const question = await createTopic(db, "alice", { lang: "en", title: "Village filter question", body: "A question.", asksStance: true, village: "en" });
  const plain = await createTopic(db, "alice", { lang: "en", title: "Village filter ordinary post", body: "A post.", village: "en" });
  if (!question.ok || !plain.ok) throw new Error("topic creation failed");
  auth.getReader.mockResolvedValue({ db });
  auth.readAuth = { db, profile: null, carryK: null, rate: null };
  const page = await villageLoader({ request: request("/v/en?asks=1"), params: { slug: "en" } } as never);
  expect(page.topics.map(topic => topic.id)).toEqual([question.id]);
  const markdown = await (await serveVillageMd(request("/v/en.md?asks=1"), "en")).text();
  expect(markdown).toContain("Village filter question");
  expect(markdown).not.toContain("Village filter ordinary post");
});
