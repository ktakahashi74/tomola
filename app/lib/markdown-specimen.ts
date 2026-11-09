// Fixed calibration workload: the maximum ordinary post, in both languages.
export function markdownSpecimen(lang: "en" | "ja"): string {
  const prose = lang === "ja"
    ? "議論では、根拠と推論を分けて示す。別の見方から読み直し、どの条件で結論が変わるかを考える。資料を共有し、問いへの応答を次の検討につなぐ。"
    : "A discussion separates evidence from inference. Readers can consider another explanation and ask which conditions change the conclusion. Sharing sources helps the next response address the question. ";
  const parts = [lang === "ja" ? "# 議論の記録\n\n" : "# Notes on discussion\n\n"];
  for (let section = 0; section < 10; section++) {
    parts.push(`## ${lang === "ja" ? "検討" : "Discussion"} ${section + 1}\n\n${prose}\n\n`);
    parts.push("- first\n  - second\n    - third\n\n> A quoted observation.\n> Another sentence.\n\n");
    parts.push("| Observation | Explanation |\n| --- | --- |\n| A | B |\n| C | D |\n\n");
    parts.push("```python\nvalues = [1, 2, 3]\nprint(sum(values))\n```\n\n");
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
