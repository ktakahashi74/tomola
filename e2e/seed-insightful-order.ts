import fs from "node:fs";
import path from "node:path";
import type { Db } from "../app/lib/db/client.server";
import { user } from "../app/lib/db/schema";
import { createTopic } from "../app/lib/entries.server";
import { createInvitation } from "../app/lib/invitations.server";
import { createProfile } from "../app/lib/profiles.server";
import { inviteUrl } from "../app/lib/site-url";
import { setVote } from "../app/lib/votes.server";

export async function seedInsightfulOrder(db: Db) {
  for (let i = 0; i < 3; i++) {
    const id = `insightful-voter-${i}`;
    await db.insert(user).values({ id, name: "", email: `${id}@example.com`, emailVerified: true });
    const profile = await createProfile(db, id, { handle: `insightful_voter_${i}`, homeArea: i === 0 ? "ja" : "en", readLangs: ["ja", "en"] });
    if (!profile.ok) throw new Error(profile.error);
  }
  const ids: number[] = [];
  for (const [index, count] of [2, 1, 1, 0, 3].entries()) {
    const topic = await createTopic(db, "seed-kim", { lang: index === 4 ? "en" : "ja", title: `Insightful ordering fixture ${index}`, body: `Ordering fixture body ${index}` }, { now: new Date(Date.UTC(2025, 0, 1, 0, index)) });
    if (!topic.ok) throw new Error(topic.error);
    ids.push(topic.id);
    for (let i = 0; i < count; i++) {
      const vote = await setVote(db, `insightful-voter-${i}`, topic.id, true);
      if (!vote.ok) throw new Error(vote.error);
    }
  }
  const { token } = await createInvitation(db, { email: "insightful_order_reader@example.com" });
  fs.writeFileSync(path.join(path.dirname(process.env.PGLITE_DATA_DIR!), "insightful-order.json"), JSON.stringify({ ids, invite: inviteUrl(token) }));
}
