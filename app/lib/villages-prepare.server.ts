import { safeErrorText } from "~/lib/error-text.server";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { entries, profiles, villageMembers, villages } from "~/lib/db/schema";
import { enabledLangs } from "~/lib/enabled-langs.server";
import { enrollInVillage, ensureLanguageVillages } from "~/lib/villages.server";
import { applyVillageTexts, planVillageTexts } from "~/lib/village-translations.server";

type Env = Record<string, string | undefined>;
export async function prepareVillages(db: Db, opts: { write?: boolean; env?: Env } = {}) {
  const langs = enabledLangs(opts.env);
  return db.transaction(async tx => {
    const present = await tx.select().from(villages);
    // Leaving preserves this stamp: subsequent preparation must respect that choice.
    const members = await tx.select({ userId: profiles.userId, homeArea: profiles.homeArea, defaultVillageId: profiles.defaultVillageId }).from(profiles)
      .where(isNull(profiles.villagePreparedAt)).for("update");
    const topics = await tx.select({ id: entries.id, authorArea: entries.authorArea, lang: entries.lang }).from(entries)
      .where(and(eq(entries.kind, "topic"), isNull(entries.villageId))).for("update");
    const available = new Set<string>([...langs, ...present.filter(village => village.kind === "open" && village.endedAt === null && village.language !== null).map(village => village.language!)]);
    const targets = topics.map(topic => ({ ...topic, target: topic.authorArea && topic.authorArea !== "other" ? topic.authorArea : topic.lang }));
    const unresolved = targets.filter(topic => !available.has(topic.target));
    const missingLanguages = langs.filter(lang => !present.some(village => village.language === lang));
    // A conflicting slug must be adjudicated by an operator, even on a dry run.
    const collisions = missingLanguages.filter(lang => present.some(village => village.slug === lang.toLowerCase()));
    const memberships = await tx.select().from(villageMembers);
    const eligible = members.filter(member => available.has(member.homeArea));
    const joining = eligible.filter(member => {
      const village = present.find(row => row.language === member.homeArea);
      return !village || !memberships.some(row => row.villageId === village.id && row.userId === member.userId);
    });
    const texts = await planVillageTexts(tx, opts.env);
    const result = { written: false, textLanguages: texts.fill.length, textPlan: texts.fill, translations: texts.pairs, missingLanguages, memberships: joining.length, defaults: 0, topics: topics.length, unresolved: unresolved.map(({ id, authorArea, lang, target }) => ({ id, authorArea, lang, target })), collisions };
    if (!opts.write || unresolved.length || collisions.length) return result;
    await ensureLanguageVillages(tx, opts.env);
    const languageRows = await tx.select().from(villages);
    for (const member of eligible) {
      const village = languageRows.find(row => row.language === member.homeArea)!;
      await enrollInVillage(tx, member.userId, village.id);
    }
    for (const topic of targets) {
      const village = languageRows.find(row => row.language === topic.target)!;
      await tx.update(entries).set({ villageId: village.id }).where(and(eq(entries.id, topic.id), isNull(entries.villageId)));
    }
    // The texts of villages made before they had a language: name it, and queue the missing translations (a failed one is tried again).
    await applyVillageTexts(tx, await planVillageTexts(tx, opts.env), opts.env);
    return { ...result, written: true };
  });
}

export async function runPrepareVillages(argv: readonly string[], deps: { getDb: () => Promise<Db>; env?: Env; log?: (line: string) => void; error?: (line: string) => void }): Promise<number> {
  const log = deps.log ?? console.log;
  const error = deps.error ?? console.error;
  if (argv.some(arg => arg !== "--write" && arg !== "--dry-run") || (argv.includes("--write") && argv.includes("--dry-run"))) {
    error("usage: pnpm villages:prepare [--dry-run | --write]");
    return 1;
  }
  try {
    const result = await prepareVillages(await deps.getDb(), { write: argv.includes("--write"), env: deps.env });
    log(`${result.written ? "written" : "dry run"}: ${result.missingLanguages.length} language villages, ${result.memberships} memberships, ${result.defaults} defaults, ${result.topics} topics, ${result.textLanguages} village texts to name a language for, ${result.translations} village translations to make`);
    // One line per village that is to be given a language, so a wrong call (a short text, a name in Han characters) is seen before anything is written.
    for (const row of result.textPlan) log(`village ${row.slug ?? row.id}: source language ${row.lang} (${{ author: "from its author", text: "from its text", default: "the site's default" }[row.by]})`);
    for (const topic of result.unresolved) error(`topic ${topic.id}: no language village for ${topic.target} (author_area=${topic.authorArea ?? "NULL"}, original=${topic.lang})`);
    for (const lang of result.collisions) error(`village slug ${lang.toLowerCase()} is already in use`);
    if (result.unresolved.length || result.collisions.length) {
      error("Preparation stopped without writes. An operator must decide how to resolve the listed topics or slugs.");
      return 1;
    }
    if (!result.written) log("Nothing changed. Review the plan, then run pnpm villages:prepare --write.");
    return 0;
  } catch (cause) {
    error(`villages:prepare: ${safeErrorText(cause)}`);
    return 1;
  }
}
