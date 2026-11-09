import { eq } from "drizzle-orm";
import type { Db } from "../app/lib/db/client.server";
import { profiles } from "../app/lib/db/schema";
import { createReply, createTopic } from "../app/lib/entries.server";
import { updateDisplayNames } from "../app/lib/display-names.server";
import { villagesEnabled } from "../app/lib/villages-enabled.server";
import { setVillageFollow } from "../app/lib/village-follows.server";

export async function seedDisplayNames(db: Db) {
  for (const handle of ["dn_single", "dn_single_save"]) {
    const [single] = await db.select().from(profiles).where(eq(profiles.handle, handle));
    await updateDisplayNames(db, single.userId, "", "Taylor Writer");
  }
  const [settings] = await db.select().from(profiles).where(eq(profiles.handle, "dn_settings"));
  await updateDisplayNames(db, settings.userId, "Previous Writer", "P. Writer");
  const [hanAuthor] = await db.select().from(profiles).where(eq(profiles.handle, "dn_han_author"));
  const [hanReply] = await db.select().from(profiles).where(eq(profiles.handle, "dn_han_reply"));
  await updateDisplayNames(db, hanAuthor.userId, "山田太郎", "Taro Yamada");
  await updateDisplayNames(db, hanReply.userId, "佐々木光", "Hikaru Sasaki");
  const hanTopic = await createTopic(db, hanAuthor.userId, { title: "Display name Han article", body: "漢字の名前とローマ字の形を確かめる記事。", lang: "ja" }, { now: new Date("2020-01-01") });
  if (!hanTopic.ok) throw Error(hanTopic.error);
  const hanResponse = await createReply(db, hanReply.userId, hanTopic.id, { body: "漢字の名前で書いた返信。", lang: "ja" }, { now: new Date("2020-01-02") });
  if (!hanResponse.ok) throw Error(hanResponse.error);
  if (villagesEnabled()) {
    const [owner] = await db.select().from(profiles).where(eq(profiles.handle, "dn_places_owner"));
    const [reader] = await db.select().from(profiles).where(eq(profiles.handle, "dn_places_reader"));
    await updateDisplayNames(db, owner.userId, "風の書き手", "Wind Writer");
    await setVillageFollow(db, reader.userId, "@dn_places_owner", true);
    const topic = await createTopic(db, owner.userId, { title: "Display name personal place", body: "自分のビレッジの表示名。", lang: "ja" }, { now: new Date("2020-01-01") });
    if (!topic.ok) throw Error(topic.error);
  }
  const [reported] = await db.select().from(profiles).where(eq(profiles.handle, "dn_reported"));
  await updateDisplayNames(db, reported.userId, "報告対象の名前", "Reported Name");
  const authors = [
    { handle: "dn_japanese", home: "ja", native: "光の書き手", latin: "Light Writer" },
    { handle: "dn_english", home: "en", native: "River Writer", latin: "R. Writer" },
  ] as const;
  for (const author of authors) {
    const [profile] = await db.select().from(profiles).where(eq(profiles.handle, author.handle));
    const saved = await updateDisplayNames(db, profile.userId, author.native, author.latin);
    if (!saved.ok) throw Error(saved.error);
    const topic = await createTopic(db, profile.userId, { lang: author.home, title: `Display name ${author.handle}`, body: author.home === "ja" ? "表示名を確かめる記事。" : "An article for display names." }, { now: new Date("2020-01-01") });
    if (!topic.ok) throw Error(topic.error);
    const other = authors.find(item => item.handle !== author.handle)!;
    const [replyAuthor] = await db.select().from(profiles).where(eq(profiles.handle, other.handle));
    const reply = await createReply(db, replyAuthor.userId, topic.id, { lang: other.home, body: "A reply for display names." }, { now: new Date("2020-01-02") });
    if (!reply.ok) throw Error(reply.error);
  }
}
