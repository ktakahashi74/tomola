import { mediaPath } from "./media";

const LIST_QUOTE_EXAMPLE = "- first\n  - second\n    - third\n\n> A quoted observation.\n> Another sentence.\n\n";
const TABLE_EXAMPLE = "| Observation | Explanation |\n| --- | --- |\n| A | B |\n| C | D |\n\n";
const CODE_EXAMPLE = "```python\nvalues = [1, 2, 3]\nprint(sum(values))\n```\n\n";

export function markdownDetailsExample(lang: "en" | "ja"): string {
  return lang === "ja"
      ? "::::details[**補足**と $x^2$]\n\n実験の設定や証明をここに書く。\n\n:::details[条件]\n\n内側より外側のコロンを 1 つ増やす。入れ子は 2 段まで。\n\n:::\n\n::::\n\n"
      : "::::details[**Supplement** and $x^2$]\n\nWrite experimental settings or a proof here.\n\n:::details[Conditions]\n\nUse one more colon on the outside when nesting, up to two levels.\n\n:::\n\n::::\n\n";
}

// Fixed calibration workload in both languages; independent of the current post limit.
export function markdownSpecimen(lang: "en" | "ja"): string {
  const prose = lang === "ja"
    ? "議論では、根拠と推論を分けて示す。別の見方から読み直し、どの条件で結論が変わるかを考える。資料を共有し、問いへの応答を次の検討につなぐ。"
    : "A discussion separates evidence from inference. Readers can consider another explanation and ask which conditions change the conclusion. Sharing sources helps the next response address the question. ";
  const parts = [lang === "ja" ? "# 議論の記録\n\n" : "# Notes on discussion\n\n"];
  for (let section = 0; section < 10; section++) {
    parts.push(`## ${lang === "ja" ? "検討" : "Discussion"} ${section + 1}\n\n${prose}\n\n`);
    parts.push(LIST_QUOTE_EXAMPLE);
    parts.push(TABLE_EXAMPLE);
    parts.push(CODE_EXAMPLE);
    parts.push(markdownDetailsExample(lang));
    for (let i = 0; i < 30; i++) {
      const n = section * 30 + i;
      parts.push(`[${lang === "ja" ? "資料" : "Source"} ${n}](https://example.org/p/${n}) `);
    }
    parts.push("\n\n");
    for (let i = 0; i < 25; i++) parts.push(lang === "ja" ? "**根拠**と*推論*を分ける。 " : "**Evidence** differs from *inference*. ");
    parts.push("\n\n");
    for (let i = 0; i < 10; i++) {
      const n = section * 10 + i;
      parts.push(i < 8 ? `$x_{${n}}^2 + y_{${n}}^2 = 1$ ` : `\n\n$$\n\\frac{x_{${n}}}{1 + y_{${n}}} = z\n$$\n\n`);
      parts.push(`${lang === "ja" ? "補足" : "Note"}[^f${n}] `);
    }
    parts.push("\n\n");
    for (let i = 0; i < 10; i++) parts.push(`[^f${section * 10 + i}]: ${lang === "ja" ? "資料を読み、条件を確かめる。" : "Read the source and check its conditions."}\n\n`);
  }
  const source = parts.join("");
  const remaining = 50_000 - source.length;
  return source + prose.repeat(Math.ceil(remaining / prose.length)).slice(0, remaining);
}

// Small author-facing examples share the calibration workload's syntax.
export function markdownWritingExamples(): { label: string; markdown: string }[] {
  const still = mediaPath("0".repeat(64), 800, 450);
  const motion = mediaPath("1".repeat(64), 800, 450);
  return [
    { label: "Headings, emphasis and links", markdown: "## An observation\n\n**Evidence** differs from *inference*. [Source](https://example.org/article)." },
    { label: "Lists and quotations", markdown: LIST_QUOTE_EXAMPLE + "1. First step\n2. Next step" },
    { label: "Tables", markdown: TABLE_EXAMPLE },
    { label: "Code", markdown: CODE_EXAMPLE },
    { label: "Footnotes and math", markdown: "An observation[^source] with $x^2$.\n\n$$\n\\frac{x}{1 + y} = z\n$$\n\n[^source]: Read the source and check its conditions." },
    { label: "Collapsible details", markdown: markdownDetailsExample("en") },
    { label: "Still image", markdown: `![A diagram showing three connected stages.](${still})` },
    { label: "Still and motion pair", markdown: `[![Three stages light up in sequence to show how a signal travels.](${still})](${motion})` },
    { label: "Mention", markdown: "@example What conditions would change this conclusion?" },
  ];
}
