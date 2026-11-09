

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { entries, user } from "~/lib/db/schema";
import { createDraft, publishDraft } from "~/lib/drafts.server";
import { createReply, createTopic } from "~/lib/entries.server";
import { changeHomeArea } from "~/lib/profiles.server";
import { addMember, createTestDb } from "./helpers/db";

const authorArea = async (db: Awaited<ReturnType<typeof createTestDb>>, id: number) =>
  (await db.select({ a: entries.authorArea }).from(entries).where(eq(entries.id, id)))[0].a;

describe("entries.author_area (the author's home area when the entry was written)", () => {
  it("is stored for topics and replies and stays when the author changes area", async () => {
    const db = await createTestDb();
    await addMember(db, "u1", "hana", { homeArea: "ja" });
    await addMember(db, "u2", "john", { homeArea: "en", readLangs: ["en"] });
    const topic = await createTopic(db, "u1", { lang: "ja", title: "t", body: "b" });
    if (!topic.ok) throw new Error("topic failed");
    const reply = await createReply(db, "u2", topic.id, { lang: "en", body: "r" });
    if (!reply.ok) throw new Error("reply failed");
    expect(await authorArea(db, topic.id)).toBe("ja");
    expect(await authorArea(db, reply.id)).toBe("en");
    await changeHomeArea(db, "u1", "de");
    await changeHomeArea(db, "u2", "other");
    expect(await authorArea(db, topic.id)).toBe("ja");
    expect(await authorArea(db, reply.id)).toBe("en");
    const later = await createReply(db, "u2", topic.id, { lang: "en", body: "again" });
    if (!later.ok) throw new Error("reply failed");
    expect(await authorArea(db, later.id)).toBe("other");
  });

  it("is the area at the time of publishing for a draft, and null when the author has no profile", async () => {
    const db = await createTestDb();
    await addMember(db, "u1", "hana", { homeArea: "ja" });
    const draft = await createDraft(db, "u1", { kind: "topic", title: "t", body: "b", lang: "ja" });
    if (!draft.ok) throw new Error("draft failed");
    await changeHomeArea(db, "u1", "fr");
    const published = await publishDraft(db, "u1", draft.id);
    if (!published.ok) throw new Error("publish failed");
    expect(await authorArea(db, published.id)).toBe("fr");
    await db.insert(user).values({ id: "ghost", name: "", email: "ghost@example.com", emailVerified: true });
    const orphan = await createTopic(db, "ghost", { lang: "ja", title: "t", body: "b" });
    if (!orphan.ok) throw new Error("topic failed");
    expect(await authorArea(db, orphan.id)).toBeNull();
  });

  it("rejects a value outside the areas (CHECK) and accepts null", async () => {
    const db = await createTestDb();
    await addMember(db, "u1", "hana");
    const values = { kind: "topic", authorId: "u1", lang: "ja", title: "t", body: "b" } as typeof entries.$inferInsert;
    await expect(db.insert(entries).values({ ...values, authorArea: "xx" })).rejects.toThrow();
    await db.insert(entries).values({ ...values, authorArea: null });
    await db.insert(entries).values({ ...values, authorArea: "zh-Hant" });
  });
});
