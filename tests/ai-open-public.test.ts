import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import { createTopic } from "~/lib/entries.server";
import { entries, profiles, villages } from "~/lib/db/schema";
import { signOpenInAiToken } from "~/lib/open-in-ai.server";
import { signAiOpenMarker, verifyAiOpenMarker } from "~/lib/ai-open-return.server";
import { canReadMarkdownPublicly, serveListMd, serveThreadMd } from "~/lib/md/twin.server";
import { action as issue } from "~/routes/open-in-ai-link";
import { action as status } from "~/routes/open-in-ai-status";

let h: RouteHarness;
const ids: Record<string, number> = {};
beforeAll(async () => {
  h = await setupRouteHarness(); await h.signIn("aip_reader", { readLangs: ["ja"] });
  for (const name of ["visible", "hidden", "deleted", "public-village", "private-village"]) {
    const topic = await createTopic(h.db, h.ids.aip_reader, { title: `AI fixture ${name}`, body: `Body ${name}`, lang: "ja" });
    if (!topic.ok) throw new Error(topic.error);
    ids[name] = topic.id;
  }
  await h.db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, ids.hidden));
  await h.db.update(entries).set({ deletedAt: new Date() }).where(eq(entries.id, ids.deleted));
  for (const [name, kind] of [["public-village", "invite_public"], ["private-village", "closed"]]) {
    const [village] = await h.db.insert(villages).values({ slug: `aip-${name}`, kind, name }).returning();
    await h.db.update(entries).set({ villageId: village.id }).where(eq(entries.id, ids[name]));
  }
}, 60000);
beforeEach(async () => {
  vi.stubEnv("PUBLIC_READING", "1");
  await h.db.update(profiles).set({ displayLang: "fr", uiLocale: "en" }).where(eq(profiles.userId, h.ids.aip_reader));
});
afterEach(() => vi.unstubAllEnvs());
afterAll(() => h.restore());
const link = async (path: string) => {
  const response = await issue(h.args(h.request("/open-in-ai/link", { as: "aip_reader", form: { path } })));
  expect(response.status).toBe(200);
  return new URL((await response.json()).url);
};
const checked = async (url: string) => (await (await status(h.args(h.request("/open-in-ai/status", { form: { url } })))).json()).read;

it("issues public member topic links with their display language and a working return marker", async () => {
  const url = await link(`/t/${ids.visible}.md`);
  expect(url.searchParams.has("k")).toBe(false);
  expect(url.searchParams.get("lang")).toBe("fr");
  expect(url.searchParams.get("o")).toMatch(/^oar1\./);
  expect(await checked(url.href)).toBe(false);
  const tracked = `${url.href}&utm_source=chatgpt.com&unknown=value`;
  const response = await serveThreadMd(new Request(tracked), String(ids.visible));
  expect(response.status).toBe(200); expect(await response.text()).toContain("Body visible");
  expect(await checked(url.href)).toBe(true); expect(await checked(tracked)).toBe(true);
  expect(await checked(url.href.replace("lang=fr", "lang=en"))).toBe(false);
  expect((await link(`/t/${ids.visible}.md?lang=en`)).searchParams.get("lang")).toBe("en");
  expect((await link(`/t/${ids.visible}.md?lang=all`)).searchParams.get("lang")).toBe("all");
  vi.stubEnv("ENABLED_LANGS", "en,ja");
  expect((await link(`/t/${ids.visible}.md`)).searchParams.get("lang")).toBe("en");
});

it("uses the same public content targets as the Markdown reader without exposing hidden placeholders", async () => {
  for (const name of ["visible", "public-village"]) {
    const path = `/t/${ids[name]}.md`;
    expect(await canReadMarkdownPublicly(h.db, path)).toBe(true);
    expect((await link(path)).searchParams.has("k")).toBe(false);
    expect(await (await serveThreadMd(h.request(path), String(ids[name]))).text()).toContain(`Body ${name}`);
  }
  for (const name of ["hidden", "deleted", "private-village"]) {
    const path = `/t/${ids[name]}.md`;
    expect(await canReadMarkdownPublicly(h.db, path)).toBe(false);
    expect((await link(path)).searchParams.get("k")).toMatch(/^oai2\./);
    expect(await (await serveThreadMd(h.request(path), String(ids[name]))).text()).not.toContain(`Body ${name}`);
  }
  expect((await link("/t/999999.md")).searchParams.has("k")).toBe(true);
});

it("uses public links only for the public lists and retains keys for personal and protected resources", async () => {
  for (const [path, spec] of [["/home.md", { kind: "home" }], ["/latest.txt", { kind: "latest" }]] as const) {
    const url = await link(path); expect(url.searchParams.has("k")).toBe(false); expect(url.searchParams.get("lang")).toBe("fr");
    expect((await serveListMd(new Request(url.href), spec)).status).toBe(200);
  }
  expect((await link("/a/ja.md")).searchParams.has("k")).toBe(false);
  for (const path of ["/following.md", "/search.md?q=text", "/changes.md", "/glossary.md", "/glossary.yaml", "/manifest.json", `/t/${ids.visible}/stances.md`]) {
    const url = await link(path); expect(url.searchParams.get("k")).toMatch(/^oai2\./); expect(url.searchParams.has("o")).toBe(false);
  }
  vi.stubEnv("PUBLIC_READING", "");
  expect((await link(`/t/${ids.visible}.md`)).searchParams.get("k")).toMatch(/^oai2\./);
});

it("allows ignored values on signed member reads but rejects page and language scope changes", async () => {
  vi.stubEnv("PUBLIC_READING", "");
  const resource = `/t/${ids.visible}.md?lang=en`;
  const token = signOpenInAiToken({ userId: h.ids.aip_reader, generation: 0, resource });
  const url = `http://localhost:5173${resource}&k=${token}`;
  const tracked = await serveThreadMd(new Request(`${url}&utm_source=chatgpt.com&unknown=value`), String(ids.visible));
  expect(tracked.status).toBe(200);
  for (const changed of [url.replace("lang=en", "lang=fr"), `${url}&page=2`]) {
    const denied = await serveThreadMd(new Request(changed), String(ids.visible));
    expect(denied.status).toBe(401); expect(await denied.text()).toContain("scope_mismatch");
  }
});

it("normalizes inert markers without loosening their path, language, signature or duplicate checks", () => {
  const path = `/t/${ids.visible}.md?lang=en`;
  const marker = signAiOpenMarker(path);
  expect(verifyAiOpenMarker(marker, `${path}&utm_source=chatgpt.com&unknown=value`)).not.toBeNull();
  for (const changed of [path.replace("lang=en", "lang=fr"), `${path}&page=2`, `${path}&utm_source=a&utm_source=b`]) expect(verifyAiOpenMarker(marker, changed)).toBeNull();
});
