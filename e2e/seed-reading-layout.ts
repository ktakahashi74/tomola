import fs from "node:fs";
import path from "node:path";
import { eq, inArray, sql } from "drizzle-orm";
import sharp from "sharp";
import type { Db } from "../app/lib/db/client.server";
import { jobs, user } from "../app/lib/db/schema";
import { createTopic } from "../app/lib/entries.server";
import { putMedia, putUploadedMedia } from "../app/lib/media-store.server";
import { rewriteMedia } from "../app/lib/media-processing.server";
import { motionImage } from "../tests/helpers/motion-images";

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

  const diagram = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="960" height="280" viewBox="0 0 960 280">
    <rect width="960" height="280" fill="#eef4fa"/>
    <path d="M48 56h864 M48 112h864 M48 168h864 M48 224h864" stroke="#becedc"/>
    <path d="M48 224 L192 192 336 208 480 116 624 146 768 76 912 56" fill="none" stroke="#245aac" stroke-width="4"/>
  </svg>`);
  const images = await Promise.all([960, 670, 320].map(async width => {
    const { data, info } = await sharp(diagram).resize({ width }).webp().toBuffer({ resolveWithObject: true });
    return putMedia(db, member.id, { bytes: data, width, height: info.height });
  }));
  const [wide, medium, small] = images;
  const motion = await putUploadedMedia(db, member.id, await rewriteMedia((await motionImage("gif", 4, 960, 280, 750)).bytes));
  const figureTopics: Record<string, number> = {};
  for (const lang of ["ja", "en"] as const) {
    const [title, heading, caption, motionHeading] = lang === "ja"
      ? ["観測値の推移", "観測結果", "図の説明。折れ線で観測値の推移を示す。", "観測値の動き"]
      : ["Changes in the observations", "Observations", "Figure caption. The line shows how the observations change over time.", "Motion in the observations"];
    const body = [
      `## ${heading}`, passages[lang].repeat(6),
      `[![Wide diagram](${wide.url})](/help)`, caption,
      `![Medium diagram](${medium.url})`, `![Small diagram](${small.url})`,
      `## ${motionHeading}`, passages[lang].repeat(12), `[![Motion diagram](${wide.url})](${motion.url})`,
      `## ${title}`, passages[lang].repeat(8),
    ].join("\n\n");
    const topic = await createTopic(db, member.id, { lang, title, body }, { now: at });
    if (!topic.ok) throw new Error(`reading figure fixture failed: ${lang}: ${topic.error}`);
    figureTopics[lang] = topic.id;
  }
  const ids = [...Object.values(topics), ...Object.values(figureTopics), noHeadings.id];
  await db.delete(jobs).where(inArray(sql<number>`(${jobs.payload}->>'entryId')::bigint`, ids));
  fs.writeFileSync(path.join(dir, "reading-layout.json"), JSON.stringify({ topics, noHeadingsId: noHeadings.id, figureTopics, motionUrl: motion.url }));
}
