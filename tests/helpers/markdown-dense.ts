export function denseMarkdown(lang: "en" | "ja"): string {
  const word = lang === "en" ? "Evidence" : "根拠と議論";
  const parts = [`# ${word}\n\n`];
  for (let i = 0; i < 150; i++) parts.push(`${word} $x_{${i}}^2 + y^2$\n\n`);
  for (let i = 0; i < 20; i++) parts.push(`## ${word} ${i}\n\n| A | B |\n| --- | --- |\n| ${word} | ${i} |\n\n`);
  for (let i = 0; i < 500; i++) parts.push(`[${word} ${i}](https://example.org/reference/${i}) `);
  parts.push("\n\n");
  for (let i = 0; i < 200; i++) parts.push(`${word}[^note${i}]\n\n[^note${i}]: ${word}.\n\n`);
  const source = parts.join("");
  if (source.length > 50_000) throw new Error("Dense specimen exceeds body length");
  const paragraph = `${word}. `;
  return (source + paragraph.repeat(Math.ceil((50_000 - source.length) / paragraph.length))).slice(0, 50_000);
}
