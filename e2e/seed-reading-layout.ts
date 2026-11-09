import fs from "node:fs";
import path from "node:path";
import { eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../app/lib/db/client.server";
import { jobs, user } from "../app/lib/db/schema";
import { createTopic } from "../app/lib/entries.server";

export async function seedReadingLayout(db: Db, dir: string) {
  const [member] = await db.select({ id: user.id }).from(user).where(eq(user.email, "reading_layout@example.com"));
  const passages = {
    ja: "読む人が考えを追い、節のつながりを確かめながら文章を読み進める。",
    "zh-Hans": "读者沿着文章的思路，逐节阅读，并随时回到需要重新思考的段落。",
    "zh-Hant": "讀者沿著文章的思路，逐節閱讀，並隨時回到需要重新思考的段落。",
    ko: "독자는 글의 흐름을 따라 각 절을 읽고 필요한 문단으로 돌아와 생각을 확인한다.",
    en: "Readers follow an idea through each section and return to a passage to consider it again. ",
  };
  const topics: Record<string, number> = {};
  const at = new Date("2025-12-02T12:00:00Z");
  for (const [lang, passage] of Object.entries(passages)) {
    const heading = lang === "ja" ? "節のつながりを確かめながら文章を読む" : passage;
    const body = Array.from({ length: 3 }, (_, i) => `## ${heading} ${i + 1}\n\n${passage.repeat(12)}`).join("\n\n");
    const topic = await createTopic(db, member.id, { lang, title: passage, body }, { now: at });
    if (!topic.ok) throw new Error(`reading layout fixture failed: ${lang}: ${topic.error}`);
    topics[lang] = topic.id;
  }
  const noHeadings = await createTopic(db, member.id, { lang: "ja", title: "節のない文章を読む", body: passages.ja.repeat(4) }, { now: at });
  if (!noHeadings.ok) throw new Error("reading layout fixture without headings failed");
  const ids = [...Object.values(topics), noHeadings.id];
  await db.delete(jobs).where(inArray(sql<number>`(${jobs.payload}->>'entryId')::bigint`, ids));
  fs.writeFileSync(path.join(dir, "reading-layout.json"), JSON.stringify({ topics, noHeadingsId: noHeadings.id }));
}
