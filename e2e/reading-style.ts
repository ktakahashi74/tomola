import fs from "node:fs";

// Read the stylesheet's values so geometry checks follow the layout definitions.
const readingCss = fs.readFileSync(new URL("../app/app.css", import.meta.url), "utf8");
export const [breakpointEm, centeredBreakpointEm] = [...readingCss
  .matchAll(/@media \(min-width: ([\d.]+)em\) \{(?:(?!@media)[\s\S])*?body:has\(\.reading-toc-sidebar\)/g)]
  .map(match => Number(match[1]));
export const navigationBreakpointEm = Number(readingCss
  .match(/@media \(min-width: ([\d.]+)em\) \{\s+\/\*[\s\S]*?\*\/\s+body:has\(\.site-navigation\)/)![1]);
export const cjkCharacters = Number(readingCss.match(/--reading-cjk-measure:\s*calc\(([\d.]+)\s*\*/)![1]);
export const latinEms = Number(readingCss.match(/--reading-latin-measure:\s*([\d.]+);/)![1]);
