import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { basename } from "node:path";
import { promisify } from "node:util";
import { LANGS, type Lang } from "./languages";

const execute = promisify(execFile);
export type FigureFontWeight = "normal" | "bold";
const fontFiles: Record<string, Record<FigureFontWeight, string>> = {
  "Noto Sans": { normal: "NotoSans-Regular.ttf", bold: "NotoSans-Bold.ttf" },
  "Noto Sans Thai": { normal: "NotoSansThai-Regular.ttf", bold: "NotoSansThai-Bold.ttf" },
  ...Object.fromEntries(["JP", "KR", "SC", "TC"].map(region => [`Noto Sans CJK ${region}`, { normal: "NotoSansCJK-Regular.ttc", bold: "NotoSansCJK-Bold.ttc" }])),
};
export const figureFont = (lang: Lang) => lang === "th" ? "Noto Sans Thai" : lang === "ja" ? "Noto Sans CJK JP" : lang === "ko" ? "Noto Sans CJK KR" : lang === "zh-Hans" ? "Noto Sans CJK SC" : lang === "zh-Hant" ? "Noto Sans CJK TC" : "Noto Sans";
export const figureFontDescription = (lang: Lang, size: number, weight: FigureFontWeight = "normal") => `${figureFont(lang)} ${weight === "bold" ? "Bold " : ""}${size}`;
export type FontCoverage = readonly (readonly [number, number])[];

// Accept only the requested faces shipped in the runtime image. A successful
// fontconfig fallback to another family is not evidence that this font exists.
export function parseFontCoverage(output: string, family: string, weight: FigureFontWeight = "normal"): FontCoverage | null {
  const [families, file, charset] = output.trimEnd().split("\n");
  if (!fontFiles[family] || !families?.split(",").map(name => name.trim()).includes(family) || basename(file ?? "") !== fontFiles[family][weight] || !charset) return null;
  const ranges: [number, number][] = [];
  for (const token of charset.trim().split(/\s+/)) {
    const match = /^([a-f0-9]{1,6})(?:-([a-f0-9]{1,6}))?$/i.exec(token);
    if (!match) return null;
    const from = parseInt(match[1], 16), to = parseInt(match[2] ?? match[1], 16);
    if (from > to || to > 0x10ffff) return null;
    ranges.push([from, to]);
  }
  return ranges;
}

export class FigureFontUnavailableError extends Error {
  readonly retryable = true;
  constructor(family: string, cause?: unknown) {
    super(`Figure font unavailable: ${family}`, { cause });
    this.name = "FigureFontUnavailableError";
  }
}

type FontLookup = (family: string, weight: FigureFontWeight) => Promise<FontCoverage | null>;
async function probeInstalledFont(family: string, weight: FigureFontWeight): Promise<FontCoverage | null> {
  const { stdout } = await execute("fc-match", ["-f", "%{family}\n%{file}\n%{charset}\n", `${family}:weight=${weight === "bold" ? "bold" : "regular"}`], { timeout: 3000, maxBuffer: 512 * 1024 });
  const coverage = parseFontCoverage(stdout, family, weight);
  if (coverage) await access(stdout.split("\n")[1], constants.R_OK);
  return coverage;
}

// Remember verified coverage only. A timeout, missing file or invalid match
// must be probed again on the next job attempt, including in the same process.
export function createFontCoverageLookup(probe: FontLookup = probeInstalledFont) {
  const cache = new Map<string, FontCoverage>();
  return async (family: string, weight: FigureFontWeight = "normal") => {
    const key = `${family}:${weight}`;
    const saved = cache.get(key);
    if (saved) return saved;
    try {
      const coverage = await probe(family, weight);
      if (!coverage) throw new FigureFontUnavailableError(`${family} ${weight}`);
      cache.set(key, coverage);
      return coverage;
    } catch (cause) { throw cause instanceof FigureFontUnavailableError ? cause : new FigureFontUnavailableError(`${family} ${weight}`, cause); }
  };
}
const installedCoverage = createFontCoverageLookup();

export async function assertFigureFontsAvailable(lang?: Lang, lookup: FontLookup = installedCoverage, weight: FigureFontWeight | "all" = "all"): Promise<FontCoverage[]> {
  const families = new Set((lang ? ["en", "th", "ja", lang] as const : LANGS).map(figureFont));
  const weights: FigureFontWeight[] = weight === "all" ? ["normal", "bold"] : [weight];
  return Promise.all([...families].flatMap(family => weights.map(async face => {
    const coverage = await lookup(family, face);
    if (!coverage) throw new FigureFontUnavailableError(`${family} ${face}`);
    return coverage;
  })));
}

// Missing fonts are retryable infrastructure failures. Only verified absent
// code points prevent this variant permanently; never use unrelated host fonts.
export async function canRenderFigureText(labels: readonly string[], lang: Lang, lookup: FontLookup = installedCoverage, weight: FigureFontWeight = "normal"): Promise<boolean> {
  const ranges = (await assertFigureFontsAvailable(lang, lookup, weight)).flatMap(coverage => coverage);
  const merged: [number, number][] = [];
  for (const [from, to] of ranges.sort((a, b) => a[0] - b[0])) {
    const last = merged[merged.length - 1];
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }
  const invisible = /\p{White_Space}|\p{Default_Ignorable_Code_Point}/u;
  return labels.every(label => {
    const visible = [...label].filter(char => !invisible.test(char));
    return visible.length > 0 && visible.every(char => {
      const point = char.codePointAt(0)!;
      let low = 0, high = merged.length - 1;
      while (low <= high) {
        const mid = (low + high) >>> 1, [from, to] = merged[mid];
        if (point < from) high = mid - 1;
        else if (point > to) low = mid + 1;
        else return true;
      }
      return false;
    });
  });
}
