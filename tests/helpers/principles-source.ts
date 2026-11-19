import fs from "node:fs";
import { PRINCIPLES_TRANSLATION_NOTICES, type PrinciplesLang } from "../../app/lib/principles-languages";

// Read expectations from the canonical edition, independently of the page loader.
export function readPrinciplesSource(lang: PrinciplesLang) {
  const raw = fs.readFileSync(`app/content/principles/${lang}.md`, "utf8");
  const titleStart = raw.search(/^# /m);
  if (titleStart < 0) throw new Error(`Missing principles title: ${lang}`);
  const directory = process.env.TOMOLA_OPERATOR_DIR || "tests/fixtures/operator";
  const suffixFile = `${directory}/principles-footer/${lang}.md`;
  const suffix = fs.readFileSync(fs.existsSync(suffixFile) ? suffixFile : `${directory}/principles-footer/en.md`, "utf8");
  const published = raw.slice(titleStart).split("\n");
  const first = published.findIndex((line, index) => index > 0 && line.trim() !== "");
  const notice = lang !== "ja" && published[first]?.trim().toLowerCase() === "unverified machine translation"
    ? PRINCIPLES_TRANSLATION_NOTICES[lang]
    : undefined;
  if (notice) published[first] = notice;
  const governance = published.findIndex(line => line.startsWith("## 6. "));
  published.splice(governance + 2, 0, suffix.trimEnd());
  const markdown = published.join("\n").replace(/\{\{(principles-rules-status|principles-objections-contact)\}\}/g, (_marker, kind: string) => {
    const file = `${directory}/${kind}/${lang}.md`;
    return fs.readFileSync(fs.existsSync(file) ? file : `${directory}/${kind}/en.md`, "utf8").trim();
  });
  const lines = markdown.split(/\r?\n/);
  return {
    markdown,
    notice,
    title: lines[0].slice(2).trim(),
    headings: lines.filter(line => /^## \d+\. /.test(line)).map(line => line.slice(3).trim()),
    comments: [...raw.slice(0, titleStart).matchAll(/<!--([\s\S]*?)-->/g)].map(match => match[1].trim()),
    status: lang === "ja" ? "original" : notice ? "unverified" : "human_checked",
  } as const;
}

export const expectedPrinciplesStatus = (lang: PrinciplesLang) => readPrinciplesSource(lang).status;
