import type { Db } from "./db/client.server";
import type { Profile } from "./profiles.server";
import { displayLangFor, screenReadLangsFor } from "./display-lang.server";
import { loadPickedTranslations, type DisplayInput } from "./entry-display.server";
import { decideShown, wantsTranslation } from "./display";
import type { ReadingDisplay } from "./reading-mark.server";

// Apply the screen's rules to the current source and available translations.
export async function resolveBrowserReading(db: Db, topic: DisplayInput, request: Request, profile?: Profile | null,
  reported?: "original" | "translation"): Promise<ReadingDisplay> {
  if (reported === "original") return { sourceLang: topic.lang, readLang: topic.lang, isTranslated: false };
  const lang = displayLangFor(request, profile);
  const picked = (await loadPickedTranslations(db, [topic], lang, ["body"])).get(topic.id);
  const params = new URL(request.url).searchParams;
  const has = (key: string) => params.getAll(key).includes(String(topic.id));
  const force = reported === "translation" ? "translation" :
    has("orig") ? "original" : has("old") ? "older" : has("tr") ? "translation" : null;
  const shown = decideShown({
    wants: wantsTranslation(topic.lang, screenReadLangsFor(request, profile), lang),
    hasTranslation: !!picked?.body, hasOlder: !!picked?.body && !!picked.bodyOlder, force,
  });
  return { sourceLang: topic.lang, readLang: shown === "original" ? topic.lang : lang, isTranslated: shown !== "original" };
}
