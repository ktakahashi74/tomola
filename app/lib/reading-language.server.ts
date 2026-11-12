import type { Db } from "./db/client.server";
import type { Profile } from "./profiles.server";
import { displayLangFor, screenReadLangsFor } from "./display-lang.server";
import { loadPickedTranslations, type DisplayInput } from "./entry-display.server";
import { decideShown, wantsTranslation } from "./display";

// Apply the screen's display rules without rendering content or accepting a
// language from the notification body. Missing translations count as original.
export async function browserReadingLanguage(db: Db, topic: DisplayInput, request: Request, profile?: Profile | null) {
  const lang = displayLangFor(request, profile);
  const picked = (await loadPickedTranslations(db, [topic], lang, ["body"])).get(topic.id);
  const params = new URL(request.url).searchParams;
  const has = (key: string) => params.getAll(key).includes(String(topic.id));
  const force = has("orig") ? "original" : has("old") ? "older" : has("tr") ? "translation" : null;
  const shown = decideShown({ wants: wantsTranslation(topic.lang, screenReadLangsFor(request, profile), lang), hasTranslation: !!picked?.body, hasOlder: !!picked?.bodyOlder, force });
  return shown === "original" ? topic.lang : lang;
}
