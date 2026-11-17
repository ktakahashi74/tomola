import { and, eq } from "drizzle-orm";
import { vi } from "vitest";
import { addMember, createTestDb } from "./db";
import { entries, jobs, profiles, translations } from "~/lib/db/schema";
import { createReply, createTopic, editEntry } from "~/lib/entries.server";
import { createTranslationHandlers } from "~/lib/jobs/translation-jobs.server";
import { runDueJobs } from "~/lib/jobs/queue.server";
import { createFakeEngine } from "~/lib/llm/engines/fake.server";
import { REFRESH_BODY_JOB } from "~/lib/translations.server";
import type { TranslationRequest } from "~/lib/llm/types";

export async function editedBodyFixture(kind: "topic" | "reply" = "topic") {
  vi.stubEnv("TRANSLATION_EAGER_SCOPE", "readers");
  const db = await createTestDb();
  await addMember(db, "writer", "refresh_writer");
  await db.update(profiles).set({ displayLang: "ja" }).where(eq(profiles.userId, "writer"));
  const topic = await createTopic(db, "writer", { lang: "ja", body: "An invented source paragraph." });
  if (!topic.ok) throw new Error(topic.error);
  const made = kind === "topic" ? topic : await createReply(db, "writer", topic.id, { lang: "ja", body: "An invented reply paragraph." });
  if (!made.ok) throw new Error(made.error);
  const row = async () => {
    const [entry] = await db.select().from(entries).where(eq(entries.id, made.id));
    return { ...entry, kind, lang: entry.lang as "ja" | "en" };
  };
  const original = await row();
  await db.insert(translations).values({ entryId: made.id, field: "body", lang: "fr", kind: "primary", text: "An invented old translation.", sourceHash: original.sourceHash, firstSeenAt: new Date() });
  await db.delete(jobs);
  const calls: TranslationRequest[] = [];
  const base = createFakeEngine();
  const handlers = createTranslationHandlers({ llm: { engines: {
    primary: { ...base, async translate(req) { calls.push(req); return base.translate(req); } }, secondary: null, judge: null,
  } } });
  const refreshes = () => db.select().from(jobs).where(and(eq(jobs.kind, REFRESH_BODY_JOB), eq(jobs.status, "queued")));
  const edit = async (body: string, now = new Date(), lang = "ja") => {
    const result = await editEntry(db, "writer", made.id, { body, lang }, { now });
    if (!result.ok) throw new Error(result.error);
    return row();
  };
  const run = (now: Date, limit = 100) => runDueJobs(db, handlers, { now, limit, logger: { warn() {}, error() {} } });
  return { db, id: made.id, original, row, calls, handlers, refreshes, edit, run };
}
