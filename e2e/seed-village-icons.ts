import { eq, inArray } from "drizzle-orm";
import type { Db } from "../app/lib/db/client.server";
import { profiles, villageMembers, villages } from "../app/lib/db/schema";
import { createVillage } from "../app/lib/village-management.server";
import { setVillageFollow } from "../app/lib/village-follows.server";
import { villagesEnabled } from "../app/lib/villages-enabled.server";
import { setVillageIcon } from "../app/lib/village-icon.server";
import { setMemberAvatar } from "../app/lib/member-avatar.server";
import { rewriteMedia } from "../app/lib/media-processing.server";
import { acceptChatConsent } from "../app/lib/village-chat.server";
import sharp from "sharp";

export async function seedVillageIcons(db: Db) {
  if (!villagesEnabled()) return;
  const people = await db.select().from(profiles).where(inArray(profiles.handle, ["vi_view_ja", "vi_view_en", "vi_owner", "vi_coowner", "vi_palette"]));
  const person = (handle: string) => people.find(row => row.handle === handle)!;
  const owner = person("vi_owner");
  const image = await rewriteMedia(await sharp({ create: { width: 80, height: 60, channels: 3, background: "#737373" } }).png().toBuffer(), { avatar: true });
  await setMemberAvatar(db, owner.userId, image);
  for (const slug of ["icons-view", "icons-journey"]) {
    const created = await createVillage(db, owner.userId, { slug, name: slug === "icons-view" ? "集まりのビレッジ" : "Village icon review", description: "", kind: "open", sourceLang: "ja" });
    if (!created.ok) throw Error("Village icon fixture failed");
    const [place] = await db.select().from(villages).where(eq(villages.slug, slug));
    await db.insert(villageMembers).values({ villageId: place.id, userId: person("vi_coowner").userId, role: "owner" });
    if (slug === "icons-view") {
      await setVillageIcon(db, owner.userId, slug, image);
      for (const handle of ["vi_view_ja", "vi_view_en"]) {
        await db.insert(villageMembers).values({ villageId: place.id, userId: person(handle).userId, role: "member" });
        await setVillageFollow(db, person(handle).userId, "@vi_owner", true);
        await acceptChatConsent(db, person(handle).userId, slug);
      }
    }
  }
  const palette = await createVillage(db, person("vi_palette").userId, { slug: "icons-palette", name: "Village palette", description: "", kind: "open", sourceLang: "en" });
  if (!palette.ok) throw Error("Village palette fixture failed");
}
