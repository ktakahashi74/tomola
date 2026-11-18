export function longMarkdown(lang: "en" | "ja"): string {
  const word = lang === "en" ? "Evidence" : "根拠";
  const parts = [`# ${word}\n\n`];
  for (let section = 0; section < 30; section++) {
    parts.push(`## ${word} ${section}\n\n${word} supports this paragraph.\n\n`);
    parts.push(`| A | B |\n| --- | --- |\n| ${word} | ${section} |\n\n`);
    for (let i = 0; i < 10; i++) parts.push(`$x_{${section * 10 + i}}^2 + y^2 = 1$ `);
    parts.push("\n\n```python\nvalues = [1, 2, 3]\nprint(sum(values))\n```\n\n");
    parts.push(`${word}[^n${section}]\n\n[^n${section}]: ${word}.\n\n`);
  }
  const source = parts.join("");
  const size = lang === "en" ? 100_000 : 50_000;
  const paragraph = lang === "en" ? "Evidence and inference support a discussion.\n\n" : "根拠と推論を分けて議論を進める。\n\n";
  return source + paragraph.repeat(Math.ceil((size - source.length) / paragraph.length)).slice(0, size - source.length);
}
