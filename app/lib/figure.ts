import type { Lang } from "./languages";

export const FIGURE_VERSION = 12;
export const FIGURE_CONFIDENCE = 0.85;
export type FigureRegion = {
  text: string; lang: Lang; confidence: number;
  x: number; y: number; width: number; height: number;
  orientation: "horizontal" | "vertical" | "curved";
  weight?: "bold" | "normal";
};
export type FigureReading = { lang: Lang | null; confidence: number; regions: FigureRegion[]; protectedBoxes?: Pick<FigureRegion, "x" | "y" | "width" | "height">[] };
export type FigureFallbackReason = "does_not_fit" | "math_mismatch" | "font_missing" | "unusable_reading" | "invalid_translation" | "image_too_large";
export type FigureLabelResult = {
  source: string; translation: string | null;
  status: "rendered" | "external" | "unchanged"; reason: FigureFallbackReason | null;
  required?: { width: number; height: number };
  available?: { width: number; height: number };
  maxCharacters?: number;
};

export const sameFigureLabel = (source: string, translated: string) => source.trim().toLowerCase() === translated.trim().toLowerCase();

export function figureTranslationRegions(reading: FigureReading): FigureRegion[] {
  return reading.regions.filter(region => region.lang === reading.lang);
}

export function figurePath(id: string, width: number, height: number, lang: Lang, version = FIGURE_VERSION): string {
  return `/media/${id}-${width}x${height}.${lang}.v${version}.webp`;
}

// Shared by every HTML body containing translated figures. Modified clicks keep
// their ordinary link behavior; without JavaScript the same link opens the source.
export function toggleFigure(event: { target: EventTarget | null; button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; preventDefault(): void }): void {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || !(event.target instanceof Element)) return;
  const link = event.target.closest<HTMLAnchorElement>("a[data-figure-toggle]");
  const figure = link?.closest("[data-translated-figure]");
  const image = figure?.querySelector<HTMLImageElement>("img");
  if (!link || !image || !figure) return;
  event.preventDefault();
  const original = figure.getAttribute("data-figure-original")!;
  const translated = figure.getAttribute("data-figure-translated")!;
  const showingOriginal = image.getAttribute("src") === original;
  image.setAttribute("src", showingOriginal ? translated : original);
  figure.querySelector<HTMLElement>("[data-figure-fallback]")?.toggleAttribute("hidden", !showingOriginal);
  link.setAttribute("href", showingOriginal ? original : translated);
  link.textContent = link.getAttribute(showingOriginal ? "data-figure-source-label" : "data-figure-translation-label");
}

// Visual variants only. Do not normalize superscripts, subscripts, derivatives
// or mathematical alphabet styles through a blanket compatibility conversion.
export const FIGURE_MATH_VARIANTS: Readonly<Record<string, string>> = {
  "ϵ": "ε", "ϑ": "θ", "ϕ": "φ", "ϱ": "ρ", "ϖ": "π", "ϰ": "κ", "ϐ": "β",
  "＋": "+", "－": "−", "＝": "=", "＜": "<", "＞": ">", "／": "/", "＊": "*", "｜": "|", "＾": "^", "＿": "_", "（": "(", "）": ")",
};
// Readings can spell visible symbols as TeX. Normalize only the working copy
// before translation so saved readings remain reusable without another call.
const sourceMathCommands: Readonly<Record<string, string>> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", zeta: "ζ", eta: "η", theta: "θ", iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", omicron: "ο", pi: "π", rho: "ρ", sigma: "σ", tau: "τ", upsilon: "υ", phi: "φ", chi: "χ", psi: "ψ", omega: "ω",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ", Upsilon: "Υ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
  varepsilon: "ε", vartheta: "θ", varphi: "φ", varrho: "ρ", varpi: "π", varkappa: "κ",
  partial: "∂", nabla: "∇", sum: "∑", prod: "∏", int: "∫", infty: "∞", le: "≤", leq: "≤", ge: "≥", geq: "≥", times: "×", cdot: "⋅", pm: "±", sim: "∼",
};
export function normalizeFigureReading(reading: FigureReading): FigureReading {
  return { ...reading, regions: reading.regions.map(region => ({
    ...region,
    text: region.text.replace(/\\([A-Za-z]+)/g, (command, name: string) => Object.hasOwn(sourceMathCommands, name) ? sourceMathCommands[name] : command),
  })) };
}
// Compare formula tokens and their multiplicity, preserving semantic distinctions.
export function preservesFigureMath(source: string, translated: string): boolean {
  // Sources already contain visible symbols. Preserve literal source escapes,
  // but reject new or duplicated escapes before scanning formula tokens.
  const commands = (text: string) => {
    const counts = new Map<string, number>();
    for (const [command] of text.matchAll(/\\[A-Za-z]+/g)) counts.set(command, (counts.get(command) ?? 0) + 1);
    return counts;
  };
  const sourceCommands = commands(source);
  for (const [command, count] of commands(translated)) {
    if (sourceCommands.get(command) !== count) return false;
  }
  const tokens = (text: string, allowAsciiMinus = false) => {
    const normalized = [...text].map(c => FIGURE_MATH_VARIANTS[c] ?? c).join("");
    const comparable = allowAsciiMinus ? normalized.replace(/-/g, "−") : normalized;
    return (comparable.match(/[A-Za-z\u0370-\u03ff][A-Za-z0-9\u0370-\u03ff]*\([^()\r\n]*\)|[A-Za-z0-9\u0370-\u03ff]+(?:[_^](?:\{[^{}\r\n]+\}|[A-Za-z0-9]+))+|[+=<>|]|\p{Sm}|[\u0370-\u03ff\u1f00-\u1fff\u2070-\u214f\u1d2c-\u1d6a\u1d9b-\u1dbf\u00b0\u00b2\u00b3\u00b9\u{1d400}-\u{1d7ff}]/gu) ?? []).map(token => token.replace(/-/g, "−"));
  };
  const remaining = new Map<string, number>();
  for (const token of tokens(translated, true)) remaining.set(token, (remaining.get(token) ?? 0) + 1);
  return tokens(source).every(token => {
    const count = remaining.get(token) ?? 0;
    remaining.set(token, count - 1);
    return count > 0;
  });
}
