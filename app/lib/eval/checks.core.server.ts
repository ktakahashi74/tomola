import { createMarkdownProcessor } from "~/lib/markdown-parser.core.server";
import { checkStructure, extractCode, proseOf, trimBareUrl } from "~/lib/llm/structure.core.server";
import { evalMentions, type EvalCheck, type CheckResult } from "./cases.server";

type Node = { type: string; value?: string; url?: string; depth?: number; ordered?: boolean; children?: Node[]; position?: { start: { offset?: number } } };
const markdown = createMarkdownProcessor();
function nodes(text: string): Node[] {
  const out: Node[] = [];
  const walk = (node: Node) => { out.push(node); node.children?.forEach(walk); };
  walk(markdown.parse(text) as Node);
  return out;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sorted = (values: string[]) => values.sort();
function urls(text: string): string[] {
  return sorted(nodes(text).filter(n => n.url).map(n => {
    const offset = n.position?.start.offset;
    return offset !== undefined && !["[", "<", "!"].includes(text[offset]) ? trimBareUrl(n.url!) : n.url!;
  }));
}
// Compare numeric values, allowing translated month names and 3割 / 30% / 0.3.
// Qualifiers and the relationship between numbers remain semantic checks.
function numbers(text: string): string[] {
  const months = ["January|janvier", "February|février", "March|mars", "April|avril", "May|mai", "June|juin", "July|juillet", "August|août", "September|septembre", "October|octobre", "November|novembre", "December|décembre"];
  let normalized = proseOf(text).normalize("NFKC");
  months.forEach((names, i) => { normalized = normalized.replace(new RegExp(`\\b(?:${names})\\b`, "gi"), String(i + 1)); });
  const chineseNumber = (word: string) => {
    const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    if (![...word].some(c => "十百千".includes(c))) return Number([...word].map(c => digits[c]).join(""));
    let total = 0, digit = 0;
    for (const c of word) { const unit = ({ 十: 10, 百: 100, 千: 1000 } as Record<string, number>)[c]; if (unit) { total += (digit || 1) * unit; digit = 0; } else digit = digits[c]; }
    return total + digit;
  };
  // Normalize common multiplicative expressions without dropping numeric checks.
  const frenchEndings = "e|es|er|ez|ent|ons|é|és|ée|ées|era|eras|erai|erons|erez|eront|erais|erait|eraient|erions|eriez|ais|ait|aient|ions|iez|ant|ement|ements";
  for (const [value, english, french, korean] of [
    [2, "twice|twofold|double(?:s|d)?|doubling|two\\s+times|deux\\s+fois", "doubl", "두|이"],
    [3, "thrice|threefold|triple(?:s|d)?|tripling|three\\s+times|trois\\s+fois", "tripl", "세|삼"],
    [4, "fourfold|quadruple(?:s|d)?|quadrupling|four\\s+times|quatre\\s+fois", "quadrupl", "네|사"],
  ] as const) {
    const words = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${english}|${french}(?:${frenchEndings}))(?![\\p{L}\\p{N}_])`, "giu");
    normalized = normalized.replace(words, String(value))
      .replace(new RegExp(`(?<![\\p{L}\\p{N}_])(?:${korean})\\s*배`, "gu"), String(value));
  }
  normalized = normalized.replace(/百分之([零〇一二两兩三四五六七八九十百千]+|\d+(?:\.\d+)?)/g, (_, n: string) => `${/^\d/.test(n) ? n : chineseNumber(n)}%`)
    .replace(/[零〇一二两兩三四五六七八九十百千]+(?=[年月日倍成件条條])/g, n => String(chineseNumber(n)))
    .replace(/翻倍|翻一番/g, "2倍")
    .replace(/翻[两兩二]番/g, "4倍")
    .replace(/\b(?:three tenths|trois dixièmes)\b/gi, "0.3")
    .replace(/\b(?:forty[- ]seven|quarante[- ]sept)\b/gi, "47")
    .replace(/\b(?:fourteen|quatorze)\b/gi, "14")
    .replace(/(\d+),(\d+)\s*(?=%|pour cent|per cent|percent)/gi, "$1.$2")
    .replace(/(\d+(?:\.\d+)?)\s*(?:pour cent|per cent|percent)\b/gi, "$1%");
  normalized = normalized.replace(/(\d+(?:\.\d+)?)\s*割/g, (_, n: string) => String(Number(n) / 10))
    .replace(/(\d+(?:\.\d+)?)\s*成/g, (_, n: string) => String(Number(n) / 10))
    .replace(/(\d+(?:\.\d+)?)\s*%/g, (_, n: string) => String(Number(n) / 100));
  return sorted([...normalized.matchAll(/\d+(?:\.\d+)?/g)].map(m => String(Number(m[0]))));
}
export function deterministicCheck(check: EvalCheck, source: string, translation: string, heavy: boolean): CheckResult {
  if (check.kind === "semantic") throw new Error("Semantic checks require the judge");
  let preserved: boolean;
  const tree = (text: string) => nodes(text);
  switch (check.kind) {
    case "mentions": preserved = same(sorted(evalMentions(source)), sorted(evalMentions(translation))); break;
    case "urls": preserved = same(urls(source), urls(translation)); break;
    case "code": {
      const a = extractCode(source), b = extractCode(translation);
      preserved = same(a.fenced, b.fenced) && same(sorted(a.inline), sorted(b.inline)); break;
    }
    case "math": preserved = same(tree(source).filter(n => ["math", "inlineMath"].includes(n.type)).map(n => [n.type, n.value]), tree(translation).filter(n => ["math", "inlineMath"].includes(n.type)).map(n => [n.type, n.value])); break;
    case "markdown": {
      const shape = (text: string) => tree(text).filter(n => n.type !== "text").map(n => [n.type, n.depth, n.ordered]);
      preserved = checkStructure(source, translation).ok && same(shape(source), shape(translation)); break;
    }
    case "numbers": preserved = same(numbers(source), numbers(translation)); break;
  }
  return { id: check.id, preserved, severe: !preserved && heavy, reason: `${check.kind}: ${preserved ? "preserved" : "changed or missing"}` };
}
