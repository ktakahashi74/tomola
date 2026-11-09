import fs from "node:fs";
import type { PrinciplesLang } from "../../app/lib/principles-languages";

// Expectations come from the authored files, independently of the page loader.
export function readNameSource(lang: PrinciplesLang) {
  const raw = fs.readFileSync(`app/content/name/${lang}.md`, "utf8");
  const title = raw.match(/^# (.+)$/m)?.[1];
  const signature = raw.trimEnd().split("\n").at(-1);
  if (!title || !signature) throw new Error(`Missing name heading or signature: ${lang}`);
  return { title, signature };
}
