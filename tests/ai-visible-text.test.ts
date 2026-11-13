import { expect, it } from "vitest";
import { aiVisibleMarkdown } from "~/lib/ai-visible-text.server";

const concealedFormulas = [
  String.raw`\def\x{SECRET}\x`, String.raw`\gdef\x{SECRET}\x`, String.raw`\edef\x{SECRET}\x`, String.raw`\xdef\x{SECRET}\x`,
  String.raw`\let\x\relax SECRET`, String.raw`\futurelet\x\relax SECRET`,
  String.raw`\newcommand{\x}{SECRET}\x`, String.raw`\renewcommand{\x}{SECRET}\x`, String.raw`\providecommand{\x}{SECRET}\x`,
  String.raw`\csname SECRET\endcsname`, String.raw`\mathchoice{SECRET}{a}{b}{c}`, String.raw`\TextOrMath{SECRET}{x}`,
  String.raw`\@firstoftwo{x}{SECRET}`,
  String.raw`\color{white}{SECRET}`, String.raw`\textcolor{white}{SECRET}`,
  String.raw`\colorbox{white}{SECRET}`, String.raw`\fcolorbox{white}{white}{SECRET}`,
  ...["blue", "orange", "pink", "red", "green", "gray", "purple", "kaBlue", "kaGreen",
    ...["blue", "teal", "green", "gold", "red", "maroon", "purple"].flatMap(color => [..."ABCDE"].map(shade => color + shade)),
    ...[..."ABC"].map(shade => "mint" + shade), ...[..."ABCDEFGHI"].map(shade => "gray" + shade),
  ].map(command => `\\${command}{SECRET}`),
  String.raw`\htmlClass{hidden}{SECRET}`, String.raw`\htmlId{SECRET}{x}`, String.raw`\htmlStyle{display:none}{SECRET}`,
  String.raw`\htmlData{hidden=SECRET}{x}`, String.raw`\html@mathml{x}{SECRET}`,
  String.raw`\href{https://example.invalid/SECRET}{x}`, String.raw`\url{https://example.invalid/SECRET}`,
  String.raw`\includegraphics{SECRET}`, String.raw`\raisebox{-100em}{SECRET}`,
  String.raw`\kern-100em SECRET`, String.raw`\mkern-100mu SECRET`,
  String.raw`\hskip-100em SECRET`, String.raw`\vskip-100em SECRET`, String.raw`\mskip-100mu SECRET`,
  String.raw`\hspace{-100em}SECRET`, String.raw`\hspace*{-100em}SECRET`, String.raw`\vspace{-100em}SECRET`,
  String.raw`\mspace{-100mu}SECRET`, String.raw`\tmspace-{100mu}{100em}SECRET`,
  ...["llap", "rlap", "clap", "mathllap", "mathrlap", "mathclap", "smash"].map(command => `\\${command}{SECRET}`),
  String.raw`\rule{100em}{100em}SECRET`,
];

it.each(concealedFormulas)("omits the entire formula containing %s from AI evidence", async formula => {
  for (const delimiter of ["$", "$$"]) {
    const result = await aiVisibleMarkdown(`Before.\n\n${delimiter}\nVISIBLE_IN_FORMULA ${formula}\n${delimiter}\n\nAfter.`, true);
    expect(result.text.split(/\s+/)).toEqual(["Before.", "After."]);
    expect(result.html).not.toMatch(/SECRET|VISIBLE_IN_FORMULA/);
  }
});

it("retains visible formulas and prices while removing phantom arguments and TeX comments", async () => {
  const source = String.raw`Price $5 and $10. Formula $x^2 + y^2$ and $\frac{a}{b} + \sqrt{c}$.

$$
E=mc^2 + \phantom{SECRET} + \hphantom{SECRET} + \vphantom{SECRET} % SECRET
$$`;
  const evidence = await aiVisibleMarkdown(source, true);
  for (const visible of ["$5 and $10", "$x^2 + y^2$", String.raw`$\frac{a}{b} + \sqrt{c}$`, "E=mc^2"]) expect(evidence.text).toContain(visible);
  expect(evidence.text).not.toContain("SECRET");
  expect((await aiVisibleMarkdown(source)).text).not.toContain("E=mc^2");
});
