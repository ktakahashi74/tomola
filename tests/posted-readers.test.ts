import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { addMember, createTestDb } from "./helpers/db";
import { entries, profiles } from "~/lib/db/schema";
import { createTopic } from "~/lib/entries.server";
import { postedTranslationStates } from "~/lib/posted-status.server";
import { createTranslationHandlers } from "~/lib/jobs/translation-jobs.server";
import { runDueJobs } from "~/lib/jobs/queue.server";
import { createFakeEngine } from "~/lib/llm/engines/fake.server";
import Notice from "~/components/posted-topic-notice-content";

vi.mock("~/paraglide/messages.js", () => ({ m: new Proxy({}, { get: (_, key) => () => String(key) }) }));
afterEach(() => vi.unstubAllEnvs());

function render(initial: Parameters<typeof Notice>[0]["initial"], enabledLangs = ["ja", "en"]) {
  const router = createMemoryRouter([{ id: "root", path: "/", loader: () => ({ enabledLangs }), element: createElement(Notice, { topicId: 1, lang: "ja", firstPost: false, initial, editHref: "/t/1/edit" }) }], { hydrationData: { loaderData: { root: { enabledLangs } } } });
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}

it.each(["all", ""])("finishes the author's notice with eager scope %s, excluding unrequested body languages", async scope => {
  vi.stubEnv("TRANSLATION_EAGER_SCOPE", scope);
  const db = await createTestDb();
  for (const [id, lang] of [["author", "ja"], ["reader", "en"]]) {
    await addMember(db, id, `notice_${id}`);
    await db.update(profiles).set({ displayLang: lang }).where(eq(profiles.userId, id));
  }
  const made = await createTopic(db, "author", { lang: "ja", body: "投稿の本文。" });
  if (!made.ok) throw Error(made.error);
  const [row] = await db.select().from(entries).where(eq(entries.id, made.id));
  const input = { id: row.id, lang: "ja" as const, sourceHash: row.sourceHash };
  const initial = await postedTranslationStates(db, input);
  expect(initial.every(item => item.state === "pending")).toBe(true);
  expect(initial.map(item => item.lang)).toEqual(scope === "all" ? ["en", "fr", "de", "zh-Hant", "zh-Hans", "ko", "th", "vi"] : ["en"]);
  expect(render(initial)).toContain("posted_translating");
  await runDueJobs(db, createTranslationHandlers({ llm: { engines: { primary: createFakeEngine(), secondary: null, judge: null } } }), { now: new Date(Date.now() + 1000), limit: 100 });
  const finished = await postedTranslationStates(db, input);
  expect(finished).toEqual(initial.map(item => ({ ...item, state: "available" })));
  expect(render(finished)).toContain("posted_all_reached");
  expect(render(finished)).not.toContain("posted_translating");
});

it("reports completion when no body translation has been requested", () => {
  expect(render([])).toContain("posted_all_reached");
  expect(render([])).not.toContain("posted_translating");
});

it("omits translation progress when there are no target languages, keeping the publication confirmation", () => {
  const html = render([], ["ja"]);
  expect(html).toContain("posted_topic_public_no_place");
  expect(html).not.toContain("posted_all_reached");
  expect(html).not.toContain("posted_translating");
});
