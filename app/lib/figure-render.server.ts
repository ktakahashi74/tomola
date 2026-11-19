import { setImmediate } from "node:timers/promises";
import sharp, { type OverlayOptions } from "sharp";
import { FIGURE_CONFIDENCE, figureTranslationRegions, normalizeFigureReading, normalizeFigureNewlines, preservesFigureMath, sameFigureLabel, type FigureReading, type FigureRegion } from "./figure";
import type { Lang } from "./languages";
import { MEDIA_LIMITS } from "./media";
import { assertFigureFontsAvailable, canRenderFigureText, figureFontDescription, type FigureFontWeight } from "./figure-fonts.server";
import { FIGURE_OVERLAP, figureOverlapBackground, figureOverlapEraseGuard, figureOverlapPosition, figureOverlapTreatment, prepareFigureOverlap } from "./figure-overlap.server";

export const escapePango = (text: string) => text.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);

export function usableFigure(reading: FigureReading): boolean {
  const regions = figureTranslationRegions(reading);
  return reading.lang !== null && reading.confidence >= FIGURE_CONFIDENCE && regions.length > 0 && regions.every(region =>
    region.confidence >= FIGURE_CONFIDENCE && region.orientation === "horizontal");
}

import { FIGURE_SPACE, background, figureBackgroundPatch, figureBackgroundPatchAgrees, figureBox, figureEraseMask, figureInkIsRemovable, figureSpace, figureSpaceWindow, figureSurfaceSpace, inside, measureFigureInk, prepareFigureSpace, type FigureBox as Box, type FigureInk } from "./figure-space.server";
import type { FigureLabelResult } from "./figure";
export const FIGURE_MIN_FONT_SCALE = 0.75;
type Alignment = "left" | "centre" | "right";

export function figureTextColor(data: Buffer, bg: number[], ink: FigureInk): string {
  const light = (rgb: number[]) => rgb[0] * .299 + rgb[1] * .587 + rgb[2] * .114;
  const fallback = bg[3] < 128 || light(bg) > 145 ? "#111111" : "#ffffff";
  const pixels = ink.points.map(p => {
    const alpha = data[p * 4 + 3] / 255;
    const rgb = [0, 1, 2].map(c => Math.round(data[p * 4 + c] * alpha + bg[c] * (1 - alpha)));
    return { rgb, distance: Math.max(...rgb.map((v, c) => Math.abs(v - bg[c]))) };
  });
  const farthest = pixels.reduce((max, p) => Math.max(max, p.distance), 0);
  const clusters = new Map<string, number[][]>();
  for (const { rgb, distance } of pixels) if (distance >= Math.max(40, farthest * .7)) {
    const key = rgb.map(v => Math.floor(v / 32)).join(",");
    const cluster = clusters.get(key) ?? [];
    cluster.push(rgb); clusters.set(key, cluster);
  }
  // The dominant high-contrast cluster favours glyph interiors over fringes
  // and thin outlines; channel medians reject occasional compression noise.
  const cluster = [...clusters.values()].sort((a, b) => b.length - a.length)[0];
  if (!cluster) return fallback;
  const rgb = [0, 1, 2].map(c => cluster.map(p => p[c]).sort((a, b) => a - b)[Math.floor(cluster.length / 2)]);
  return Math.abs(light(rgb) - light(bg)) < 40 ? fallback : `#${rgb.map(v => v.toString(16).padStart(2, "0")).join("")}`;
}

const edgeTolerance = (a: Box, b: Box) => Math.max(4, Math.min(a.height, b.height) * .3);
function columnAlignment(i: number, regions: FigureRegion[], inks: FigureInk[], sizes: number[]): Alignment | null {
  if (inks[i].lineCount > 1) return null;
  const box = inks[i].box;
  const scores = [0, .5, 1].map(anchor => inks.filter((ink, j) => j !== i && ink.lineCount <= 1 &&
    (regions[i].weight ?? "normal") === (regions[j].weight ?? "normal") &&
    Math.max(sizes[i], sizes[j]) <= Math.min(sizes[i], sizes[j]) * 1.15 &&
    Math.abs(box.left + box.width * anchor - ink.box.left - ink.box.width * anchor) <= edgeTolerance(box, ink.box)).length);
  if (scores[0] > scores[1] && scores[0] > scores[2]) return "left";
  if (scores[2] > scores[0] && scores[2] > scores[1]) return "right";
  return null;
}

function labelGroups(regions: FigureRegion[], inks: FigureInk[], sizes: number[], alignments: (Alignment | null)[]): number[][] {
  const groups: number[][] = [];
  for (const i of regions.map((_, i) => i).sort((a, b) => inks[a].box.top - inks[b].box.top)) {
    const box = inks[i].box;
    const group = groups.find(group => {
      const j = group.at(-1)!, previous = inks[j].box;
      if (inks[i].lineCount > 1 || inks[j].lineCount > 1 || (regions[i].weight ?? "normal") !== (regions[j].weight ?? "normal")) return false;
      const h = Math.min(box.height, previous.height), gap = box.top - previous.top - previous.height;
      const aligned = [0, .5, 1].some(anchor => Math.abs(box.left + box.width * anchor - previous.left - previous.width * anchor) <= Math.max(3, h * .3));
      // Distant column members must share one edge and a bounded size range;
      // compare the whole group so small pairwise offsets cannot drift.
      const column = (["left", "right"] as const).some(edge => group.every(k => {
        const other = inks[k].box, anchor = edge === "left" ? 0 : 1;
        return (alignments[i] === edge || alignments[i] === null) && (alignments[k] === edge || alignments[k] === null) &&
          Math.abs(box.left + box.width * anchor - other.left - other.width * anchor) <= edgeTolerance(box, other);
      })) && Math.max(...group.map(k => sizes[k]), sizes[i]) <= Math.min(...group.map(k => sizes[k]), sizes[i]) * 1.15;
      return gap >= 0 && (column || gap <= h * 1.25 && aligned && Math.max(box.height, previous.height) <= h * 1.15) &&
        Math.max(...group.map(k => sizes[k]), sizes[i]) * FIGURE_MIN_FONT_SCALE <= Math.min(...group.map(k => sizes[k]), sizes[i]);
    });
    if (group) group.push(i); else groups.push([i]);
  }
  return groups;
}

function labelAlignment(box: Box, free: Box, width: number): Alignment {
  const left = box.left, right = width - box.left - box.width;
  if (Math.abs(left - right) <= Math.max(4, width * .05)) return "centre";
  if (Math.min(left, right) <= width * .15) return left < right ? "left" : "right";
  const before = box.left - free.left, after = free.left + free.width - box.left - box.width;
  return Math.abs(before - after) <= Math.max(4, box.width * .1) ? "centre" : before < after ? "left" : "right";
}
async function labelImage(label: string, region: FigureRegion, lang: Lang, color: string, size: number, width: number, height: number, align: Alignment, wrap: boolean) {
  const sourceLines = region.text.split(/\r\n|[\n\r\u2028\u2029]/).map(line => line.trim()).filter(Boolean);
  const paragraph = region.weight !== "bold" && sourceLines.length >= 2 && sourceLines.filter(line => [...line].length >= (/^(ja|ko|zh)/.test(region.lang) ? 20 : 40)).length >= Math.ceil(sourceLines.length / 2);
  // Reflow prose only when an explicit source-style break also needs wrapping.
  // Short independent lines and titles retain their intentional breaks.
  if (wrap && paragraph && /[\n\r\u2028\u2029]/.test(label) && (await textMetrics(label, lang, size, region.weight)).inkWidth > width) {
    label = label.split(/\r\n|[\n\r\u2028\u2029]/).map(line => line.trim()).join(/^(ja|ko|zh)/.test(lang) ? "" : " ");
  }
  const image = sharp({ text: {
    text: `<span foreground="${color}" lang="${lang}">${escapePango(label)}</span>`,
    font: figureFontDescription(lang, size, region.weight), width: Math.max(1, width), rgba: true, wrap: wrap ? "word-char" : "none", align,
  } });
  let measured;
  try { measured = await image.metadata(); }
  catch (error) {
    if (error instanceof Error && error.message.startsWith("text: invalid value")) return null;
    throw error;
  }
  if (measured.width! * measured.height! > MEDIA_LIMITS.pixels) return null;
  // The bundled Noto faces need at most one em at each outer edge for
  // bearings and line-metric slack; internal line spacing remains after crop.
  // Explicit edge whitespace can exceed that: allow eight em per character
  // (including tabs), and two em per leading/trailing blank line. Two pixels
  // cover rounding. Reject only beyond this conservative crop allowance.
  const lines = label.split(/\r\n|[\n\r\u2028\u2029]/);
  const edgeSpaces = Math.max(...lines.map(line => line.length - line.trim().length));
  const first = lines.findIndex(line => line.trim());
  const trailing = [...lines].reverse().findIndex(line => line.trim());
  const blankLines = first < 0 ? lines.length : first + trailing;
  const horizontalSlack = Math.ceil(size * (2 + edgeSpaces * 8)) + 2;
  const verticalSlack = Math.ceil(size * (2 + blankLines * 2)) + 2;
  if (measured.width! > width + horizontalSlack || measured.height! > height + verticalSlack) return null;
  const raster = await image.raw().toBuffer({ resolveWithObject: true });
  let left = raster.info.width, top = raster.info.height, right = -1, bottom = -1;
  // Retain every antialiased pixel, but exclude transparent Pango margins.
  for (let y = 0; y < raster.info.height; y++) {
    if (y % 64 === 0) await setImmediate();
    for (let x = 0; x < raster.info.width; x++) if (raster.data[(y * raster.info.width + x) * 4 + 3]) {
      left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = y;
    }
  }
  if (right < left || bottom < top || right - left + 1 > width || bottom - top + 1 > height) return null;
  return image.extract({ left, top, width: right - left + 1, height: bottom - top + 1 }).png().toBuffer({ resolveWithObject: true });
}

type TextMeasurement = { width: number; height: number; lineHeight: number; inkWidth: number; inkHeight: number; inkLineHeight: number };
type TextMetricCache = Map<string, Promise<TextMeasurement>>;
// Measure bounded chunks at a small size so a long rejected label cannot create
// a Pango surface wider than the raster library's limit.
async function textMetrics(text: string, lang: Lang, size: number, weight: FigureFontWeight = "normal", cache: TextMetricCache = new Map()): Promise<TextMeasurement> {
  const key = JSON.stringify([text, lang, weight]);
  let pending = cache.get(key);
  if (!pending) { pending = measureText(text, lang, weight); cache.set(key, pending); }
  const reference = await pending;
  return Object.fromEntries(Object.entries(reference).map(([key, value]) => [key, Math.ceil(value * size / 16)])) as TextMeasurement;
}
async function measureText(text: string, lang: Lang, weight: FigureFontWeight): Promise<TextMeasurement> {
  let width = 0, height = 0, maxLineHeight = 0, inkWidth = 0, inkHeight = 0, inkLineHeight = 0;
  for (const line of text.split(/\r\n|[\n\r]/)) {
    let lineWidth = 0, lineHeight = 0, lineInkWidth = 0, lineInkHeight = 0;
    const chars = [...line];
    for (let i = 0; i < chars.length; i += 128) {
      const chunk = chars.slice(i, i + 128).join("");
      if (!chunk.trim()) continue;
      const raster = await sharp({ text: { text: `<span lang="${lang}">${escapePango(chunk)}</span>`, font: figureFontDescription(lang, 16, weight), rgba: true } })
        .extend({ top: 4, bottom: 4, left: 4, right: 4, background: "#00000000" }).raw().toBuffer({ resolveWithObject: true });
      const { width: w, height: h } = raster.info;
      const ink = measureFigureInk(raster.data, w, h, { left: 4, top: 4, width: w - 8, height: h - 8 }, []);
      lineWidth += w - 8; lineHeight = Math.max(lineHeight, h - 8);
      lineInkWidth += ink.points.length ? ink.box.width : 0;
      lineInkHeight = Math.max(lineInkHeight, ...ink.lineHeights);
    }
    width = Math.max(width, lineWidth); height += lineHeight || 16;
    maxLineHeight = Math.max(maxLineHeight, lineHeight);
    inkWidth = Math.max(inkWidth, lineInkWidth); inkHeight += lineInkHeight || lineHeight || 16;
    inkLineHeight = Math.max(inkLineHeight, lineInkHeight);
  }
  return { width, height, lineHeight: maxLineHeight, inkWidth, inkHeight, inkLineHeight };
}

export async function figureFontSize(region: FigureRegion, ink: FigureInk, cache?: TextMetricCache): Promise<number> {
  const source = await textMetrics(region.text, region.lang, 16, region.weight, cache);
  const lines = Math.max(1, ink.lineCount, region.text.split(/\r\n|[\n\r]/).length);
  // Pixel row height corrects OCR's missing line breaks. Width remains a cap
  // only when no ink was measured; wrapped source lines are not one long line.
  // Compare tallest lines on both sides: averaging a short symbol line with
  // a full-height prose line would overestimate the source font size.
  const measuredHeight = ink.lineHeights.length ? Math.max(...ink.lineHeights) : ink.box.height - 4;
  return Math.max(1, Math.floor(ink.points.length ? measuredHeight * 16 / Math.max(1, source.inkLineHeight || source.lineHeight) : Math.min((ink.box.height - 4) / lines, (ink.box.width - 4) * 16 / source.width!)));
}
export async function figureCapacity(size: number, box: Box, lang: Lang, bold = false, inset = 2): Promise<number> {
  const sample = lang === "ja" || lang === "ko" || lang.startsWith("zh") ? "天地人日月山川" : "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const font = figureFontDescription(lang, size, bold ? "bold" : "normal");
  const one = await sharp({ text: { text: sample, font, rgba: true } }).metadata();
  const two = await sharp({ text: { text: `${sample}\n${sample}`, font, rgba: true } }).metadata();
  const padding = inset * 2;
  return Math.max(0, Math.floor((box.width - padding) / (one.width! / [...sample].length))) *
    (box.height - padding < one.height! ? 0 : 1 + Math.floor((box.height - padding - one.height!) / Math.max(1, two.height! - one.height!)));
}

type LabelImageCache = Map<string, ReturnType<typeof labelImage>>;
async function fitLabel(label: string, region: FigureRegion, box: Box, rectangles: Box[], originalSize: number, align: Alignment, lang: Lang, color: string, minimumSize = Math.max(1, Math.ceil(originalSize * FIGURE_MIN_FONT_SCALE)), images: LabelImageCache = new Map(), anchored = true, sourceSizeOnly = false, inset = 2) {
  const free = rectangles[0];
  const right = free.left + free.width;
  const wide = { ...box, left: align === "left" ? box.left : free.left,
    width: align === "left" ? right - box.left : align === "right" ? box.left + box.width - free.left : free.width };
  const place = async (area: Box, wrap: boolean, size: number) => {
    if (area === box || area === wide) {
      const left = Math.max(area.left, free.left), top = Math.max(area.top, free.top);
      area = { left, top, width: Math.min(area.left + area.width, free.left + free.width) - left,
        height: Math.min(area.top + area.height, free.top + free.height) - top };
    }
    const padding = inset * 2;
    if (area.width <= padding || area.height <= padding) return null;
    const contentWidth = !anchored ? area.width - padding : align === "left" ? area.left + area.width - box.left - padding : align === "right" ? box.left + box.width - area.left - padding : area.width - padding;
    if (contentWidth <= 0) return null;
    const key = JSON.stringify([label, region.weight ?? "normal", lang, color, size, contentWidth, area.height, align, wrap, inset]);
    let pending = images.get(key);
    if (!pending) {
      if (images.size >= 128) images.delete(images.keys().next().value!);
      pending = labelImage(label, region, lang, color, size, contentWidth, area.height - padding, align, wrap);
      images.set(key, pending);
    }
    const text = await pending;
    if (!text) return null;
    const preferredX = align === "left" ? box.left + inset : align === "right" ? box.left + box.width - text.info.width - inset : Math.floor(box.left + (box.width - text.info.width) / 2);
    const left = !anchored || align === "centre" ? Math.max(area.left + inset, Math.min(area.left + area.width - text.info.width - inset, preferredX)) : preferredX;
    if (left < area.left + inset || left + text.info.width > area.left + area.width - inset) return null;
    const top = Math.max(area.top + inset, Math.min(area.top + area.height - text.info.height - inset, Math.floor(box.top + (box.height - text.info.height) / 2)));
    return { text, size, position: { left, top, width: text.info.width, height: text.info.height } };
  };
  // Columns retain their source edge even when a larger free rectangle extends
  // to the other side; only centred labels use a clamped centre position.
  const cx = box.left + box.width / 2, cy = box.top + box.height / 2;
  for (const area of [box, wide, ...rectangles.filter(b => cx >= b.left && cx < b.left + b.width && cy >= b.top && cy < b.top + b.height)]) {
    const fitted = await place(area, false, originalSize);
    if (fitted) return fitted;
  }
  if (sourceSizeOnly) return null;
  for (const [area, wrap] of [[box, false], [wide, false], [wide, true], ...rectangles.map(b => [b, true] as const)] as const) {
    for (let size = originalSize; ; size = Math.max(minimumSize, Math.floor(size * .9))) {
      const fitted = await place(area, wrap, size);
      if (fitted) return fitted;
      if (size === minimumSize) break;
    }
  }
  return null;
}

export type FigureRenderResult = { bytes: Buffer | null; results: FigureLabelResult[] };

async function fitOverlap(label: string, region: FigureRegion, lang: Lang, color: string, size: number, space: NonNullable<ReturnType<typeof prepareFigureOverlap>>, align: Alignment) {
  const limit = space.window.width - 2, anchor = space.anchor;
  const widths = [...new Set([limit, ...[1, 1.25, 1.5, 2, 3].map(scale => Math.min(limit, Math.ceil(anchor.width * scale)))])];
  let best: { text: Buffer; position: Box; size: number; pixels: number; ratio: number; distance: number; aligned: boolean } | null = null;
  for (const [width, wrap] of [[limit, false], ...widths.map(width => [width, true] as const)] as const) {
    const text = await labelImage(label, region, lang, color, size, width, space.window.height - 2, align, wrap);
    if (!text) continue;
    const w = text.info.width + 2, h = text.info.height + 2;
    const placement = figureOverlapPosition(space, w, h, FIGURE_OVERLAP.maxRatio, align);
    if (!placement || best && (Number(!placement.aligned) > Number(!best.aligned) || placement.aligned === best.aligned && (placement.ratio > best.ratio || placement.ratio === best.ratio && placement.distance >= best.distance))) continue;
    const glyphs = await sharp(text.data).extend({ top: 1, bottom: 1, left: 1, right: 1, background: "#00000000" }).ensureAlpha().raw().toBuffer();
    best = { ...placement, text: glyphs, size };
  }
  return best;
}
// One label's failure never erases its source or discards other labels.
export async function renderFigureLabels(bytes: Buffer, reading: FigureReading, labels: readonly (string | null)[], lang: Lang): Promise<FigureRenderResult> {
  return (await createFigureRenderer(bytes, reading, lang))(labels);
}

// Reuse decoded pixels, ink measurements and font sizes for a shortening pass.
export async function createFigureRenderer(bytes: Buffer, reading: FigureReading, lang: Lang): Promise<(labels: readonly (string | null)[], options?: { final?: boolean }) => Promise<FigureRenderResult>> {
  reading = normalizeFigureReading(reading);
  const regions = figureTranslationRegions(reading);
  const rejected = (labels: readonly (string | null)[]): FigureRenderResult => ({ bytes: null, results: regions.map((r, i) => ({ source: r.text, translation: labels[i] ?? null, status: "external", reason: "unusable_reading" })) });
  if (!usableFigure(reading)) return async labels => rejected(labels.map(label => label === null ? null : normalizeFigureNewlines(label)));
  // Verify both weights before measuring source text, including mixed languages.
  await Promise.all([...new Set([lang, ...regions.map(r => r.lang)])].map(sourceLang => assertFigureFontsAvailable(sourceLang)));
  const { data, info } = await sharp(bytes, { limitInputPixels: MEDIA_LIMITS.pixels }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const protectedBoxes = (reading.protectedBoxes ?? []).map(r => figureBox(r, info.width, info.height));
  const boxes = reading.regions.map(r => figureBox(r, info.width, info.height)), recovered: FigureInk[] = [];
  for (const [i, box] of boxes.entries()) {
    await setImmediate();
    recovered.push(measureFigureInk(data, info.width, info.height, box, [...boxes.filter((_, j) => i !== j), ...protectedBoxes]));
  }
  // Dropped OCR labels are obstacles for glyph recovery, erasure and placement.
  recovered.push(...protectedBoxes.map(box => ({ box, points: [], lineCount: 0, lineHeights: [], uncertain: false })));
  // Recover truncated labels after the original layout has settled. Their
  // expanded boxes must not change the placement or shared size of other labels.
  const measured = recovered.map(ink => ink.original ?? ink);
  const context = prepareFigureSpace(info.width, info.height, measured, data);
  const indexes = regions.map(r => reading.regions.indexOf(r));
  const expandedLabels = indexes.flatMap((index, i) => recovered[index].original ? [i] : []);
  const expandedContext = expandedLabels.length ? prepareFigureSpace(info.width, info.height, recovered, data) : context;
  const metricCache: TextMetricCache = new Map();
  const sizes = await Promise.all(regions.map((r, i) => figureFontSize(r, measured[indexes[i]], metricCache)));
  const inks = indexes.map(i => measured[i]);
  const alignments = regions.map((_, i) => columnAlignment(i, regions, inks, sizes));
  const groups = labelGroups(regions, inks, sizes, alignments);
  const alignment = (i: number, free: Box) => alignments[i] ?? labelAlignment(inks[i].box, free, info.width);
  const colors = inks.map(ink => figureTextColor(data, background(data, info.width, info.height, ink.box), ink));
  const eraseGuards = indexes.map(index => figureOverlapEraseGuard(background(data, info.width, info.height, recovered[index].box)));
  const usableInk = indexes.map((index, i) => {
    const ink = recovered[index], { box } = ink;
    if (ink.uncertain || box.width < 8 || box.height < 8) return false;
    if (!ink.points.length) return true;
    // Reject only when even the final overlap pass cannot erase the source.
    const layout = ink.original ? expandedContext : context;
    const mask = figureEraseMask(info.width, info.height, index, ink.original ? recovered : measured, box, layout.bounds?.[index], eraseGuards[i]);
    return figureInkIsRemovable(ink, info.width, mask, box);
  });
  return async (labels, { final = true } = {}) => {
    labels = labels.map(label => label === null ? null : normalizeFigureNewlines(label));
    if (labels.length !== regions.length) return rejected(labels);
    const results = rejected(labels).results;
    const demands = await Promise.all(regions.map(async (_, i) => {
      const text = labels[i];
      if (!text || text.length > 2000 || !text.trim()) { results[i].reason = "invalid_translation"; return 0; }
      if (sameFigureLabel(regions[i].text, text)) { results[i].status = "unchanged"; results[i].reason = null; return 0; }
      if (!preservesFigureMath(regions[i].text, text)) { results[i].reason = "math_mismatch"; return 0; }
      if (!await canRenderFigureText([text], lang, undefined, regions[i].weight)) { results[i].reason = "font_missing"; return 0; }
      results[i].reason = "does_not_fit";
      const metrics = await textMetrics(text, lang, sizes[i], regions[i].weight, metricCache);
      return metrics.inkWidth / Math.max(1, measured[indexes[i]].box.width);
    }));
    const order = [...groups].sort((a, b) => Math.max(...b.map(i => demands[i])) - Math.max(...a.map(i => demands[i])) || a[0] - b[0]);
    const painted = Buffer.from(data);
    const images: LabelImageCache = new Map();
    const fallbackSurfaces: (Pick<NonNullable<ReturnType<typeof figureSurfaceSpace>>, "surface" | "erase"> | undefined)[] = [];
    const overlays: OverlayOptions[] = [], occupied: Box[] = [];
    const expandedSizes: number[] = [];
    const overlaps = (box: Box) => occupied.some(b => box.left < b.left + b.width + 2 && b.left - 2 < box.left + box.width && box.top < b.top + b.height + 2 && b.top - 2 < box.top + box.height);
    const rejectInk = (i: number) => {
      results[i] = { source: regions[i].text, translation: labels[i], status: "external", reason: "unusable_reading" };
    };
    const paint = (i: number, space: ReturnType<typeof figureSpace>, fitted: NonNullable<Awaited<ReturnType<typeof fitLabel>>>, layout: FigureInk[]) => {
      const index = indexes[i], ink = layout[index];
      const restored = figureBackgroundPatch(data, info.width, info.height, space.erase, ink, space.surface);
      if (space.surface && !figureBackgroundPatchAgrees(restored, space.erase, info.width, ink, space.surface)) return false;
      // Do not leave source glyph fragments where a protected mark prevents erasure.
      const removable = figureEraseMask(info.width, info.height, index, layout, space.erase, space.bounds);
      if (!figureInkIsRemovable(ink, info.width, removable, space.erase)) return false;
      for (let y = 0; y < space.erase.height; y++) for (let x = 0; x < space.erase.width; x++) {
        const p = y * space.erase.width + x;
        if (removable[p]) restored.copy(painted, ((space.erase.top + y) * info.width + space.erase.left + x) * 4, p * 4, p * 4 + 4);
      }
      occupied.push(fitted.position);
      overlays.push({ input: fitted.text.data, left: fitted.position.left, top: fitted.position.top });
      results[i].status = "rendered"; results[i].reason = null;
      return true;
    };
    const relaxedFit = async (i: number, minimumSize: number, space = figureSpace(data, info.width, info.height, indexes[i], measured, occupied, context), sourceSizeOnly = false, inset = 2) => {
      const fitted = space.rectangles.length ? await fitLabel(labels[i]!, regions[i], inks[i].box, space.rectangles, sizes[i],
        labelAlignment(inks[i].box, space.rectangles[0], info.width), lang, colors[i], minimumSize, images, false, sourceSizeOnly, inset) : null;
      return { space, fitted };
    };
    for (const group of order) {
      const upper = Math.min(...group.map(i => sizes[i]));
      const minimum = Math.max(...group.map(i => Math.ceil(sizes[i] * FIGURE_MIN_FONT_SCALE)));
      // The text inset supplies the last two pixels of the diagram clearance.
      const guard = Math.max(4, Math.ceil(Math.max(...group.map(i => sizes[i])) * .3)) - 2;
      const candidates: { i: number; space: ReturnType<typeof figureSpace>; fitted: NonNullable<Awaited<ReturnType<typeof fitLabel>>>; independent: boolean; anchored: boolean }[] = [];
      for (const i of group) {
        await setImmediate();
        if (results[i].reason !== "does_not_fit") continue;
        const { box, uncertain } = inks[i];
        if (uncertain || box.width < 8 || box.height < 8) { rejectInk(i); continue; }
        let space = figureSpace(data, info.width, info.height, indexes[i], measured, occupied, context, guard);
        const free = space.rectangles[0];
        const metrics = await textMetrics(labels[i]!, lang, minimum, regions[i].weight, metricCache);
        results[i].required = { width: metrics.inkWidth + 4, height: metrics.inkHeight + 4 };
        results[i].available = { width: free?.width ?? 0, height: free?.height ?? 0 };
        results[i].maxCharacters = Math.max(1, ...await Promise.all(space.rectangles.map(b => figureCapacity(minimum, b, lang, regions[i].weight === "bold"))));
        let fitted = free ? await fitLabel(labels[i]!, regions[i], box, space.rectangles, upper, alignment(i, free), lang, colors[i], upper, images, true, true) : null;
        let independent = false, anchored = true;
        let relaxed: Awaited<ReturnType<typeof relaxedFit>> | undefined;
        // Try moving at the source size before shrinking. Prefer the common
        // column layout if it also fits within every member's font floor.
        if (!fitted) {
          relaxed = await relaxedFit(i, sizes[i], undefined, true);
          if (group.length === 1 && relaxed.fitted) { ({ space, fitted } = relaxed); anchored = false; independent = true; }
          else if (free) fitted = await fitLabel(labels[i]!, regions[i], box, space.rectangles, upper, alignment(i, free), lang, colors[i], minimum, images);
        }
        // A tight member may use its own 75% floor without reducing the column
        // below another member's floor or pushing the tight member outside.
        if (!fitted) {
          relaxed = await relaxedFit(i, Math.max(1, Math.ceil(sizes[i] * FIGURE_MIN_FONT_SCALE)), relaxed?.space);
          space = relaxed.space; fitted = relaxed.fitted; anchored = false; independent = true;
          const available = space.rectangles[0];
          results[i].available = { width: available?.width ?? 0, height: available?.height ?? 0 };
          const floor = Math.max(1, Math.ceil(sizes[i] * FIGURE_MIN_FONT_SCALE));
          const required = await textMetrics(labels[i]!, lang, floor, regions[i].weight, metricCache);
          results[i].required = { width: required.inkWidth + 4, height: required.inkHeight + 4 };
          results[i].maxCharacters = Math.max(1, ...await Promise.all(space.rectangles.map(b => figureCapacity(floor, b, lang, regions[i].weight === "bold"))));
        }
        // Preserve successful layouts. Only failed labels try a spatial color
        // model or a verified backing, at the same readable font-size floor.
        if (!fitted && !space.surface) {
          const surfaceSpace = figureSurfaceSpace(data, info.width, info.height, indexes[i], measured, occupied, context);
          fallbackSurfaces[i] = surfaceSpace ? { surface: surfaceSpace.surface, erase: surfaceSpace.erase } : undefined;
          // Verified backing bounds already include clearance from the edges.
          // Try the existing layout first, then omit the duplicate text inset.
          const backing = context.surfaces?.[indexes[i]]?.backing ?? surfaceSpace?.surface?.backing;
          const attempts = [{ space: surfaceSpace, inset: 2 }, ...(backing ? [{ space, inset: 0 }, { space: surfaceSpace, inset: 0 }] : [])];
          for (const { space: alternative, inset } of attempts) {
            if (!alternative) continue;
            const retry = await relaxedFit(i, Math.max(1, Math.ceil(sizes[i] * FIGURE_MIN_FONT_SCALE)), alternative, false, inset);
            space = retry.space; fitted = retry.fitted; anchored = false; independent = true;
            results[i].available = { width: Math.max(results[i].available!.width, space.rectangles[0]?.width ?? 0),
              height: Math.max(results[i].available!.height, space.rectangles[0]?.height ?? 0) };
            const floor = Math.max(1, Math.ceil(sizes[i] * FIGURE_MIN_FONT_SCALE));
            const required = await textMetrics(labels[i]!, lang, floor, regions[i].weight, metricCache);
            results[i].required = { width: required.inkWidth + inset * 2, height: required.inkHeight + inset * 2 };
            results[i].maxCharacters = Math.max(results[i].maxCharacters!, ...await Promise.all(space.rectangles.map(b => figureCapacity(floor, b, lang, regions[i].weight === "bold", inset))));
            if (fitted) break;
          }
        }
        if (!fitted) continue;
        candidates.push({ i, space, fitted, independent, anchored });
      }
      if (!candidates.length) continue;
      const common = Math.min(...candidates.filter(c => !c.independent).map(c => c.fitted.size));
      for (const candidate of candidates) {
        const { i } = candidate, ink = measured[indexes[i]], box = ink.box;
        let space = candidate.space;
        const size = candidate.independent ? candidate.fitted.size : common;
        if (recovered[indexes[i]].original) { expandedSizes[i] = size; continue; }
        let fitted = candidate.fitted.size === size ? candidate.fitted : await fitLabel(labels[i]!, regions[i], box, space.rectangles, size, alignment(i, space.rectangles[0]), lang, colors[i], size, images);
        if (fitted && overlaps(fitted.position)) {
          space = figureSpace(data, info.width, info.height, indexes[i], measured, occupied, context, candidate.anchored ? guard : undefined);
          fitted = space.rectangles.length ? await fitLabel(labels[i]!, regions[i], box, space.rectangles, size,
            candidate.anchored ? alignment(i, space.rectangles[0]) : labelAlignment(box, space.rectangles[0], info.width), lang, colors[i], size, images, candidate.anchored) : null;
        }
        // Common-size reflow or an earlier member may consume the preferred
        // placement. Retry independently before requesting shorter text.
        if (!fitted || overlaps(fitted.position)) ({ space, fitted } = await relaxedFit(i, Math.max(1, Math.ceil(sizes[i] * FIGURE_MIN_FONT_SCALE))));
        if (!fitted || overlaps(fitted.position)) continue;
        paint(i, space, fitted, measured);
      }
    }
    for (const [i, result] of results.entries()) {
      if (result.reason === "does_not_fit" && !usableInk[i]) rejectInk(i);
    }
    // Settle every existing layout first. A rescued label cannot move or
    // resize earlier translations, and their entire raster footprints stay clear.
    const layoutOrder = final ? [...indexes.flatMap((index, i) => recovered[index].original ? [] : [i]), ...expandedLabels] : expandedLabels;
    for (const i of layoutOrder) {
      if (results[i].reason !== "does_not_fit") continue;
      await setImmediate();
      const index = indexes[i], expanded = Boolean(recovered[index].original);
      const layout = expanded ? recovered : measured, layoutContext = expanded ? expandedContext : context;
      const ink = layout[index], floor = Math.max(1, Math.ceil(sizes[i] * FIGURE_MIN_FONT_SCALE));
      if (expanded) {
        const space = figureSpace(data, info.width, info.height, index, layout, occupied, layoutContext);
        const free = space.rectangles[0];
        const minMetrics = await textMetrics(labels[i]!, lang, floor, regions[i].weight, metricCache);
        results[i].required = { width: minMetrics.inkWidth + 4, height: minMetrics.inkHeight + 4 };
        results[i].available = { width: free?.width ?? 0, height: free?.height ?? 0 };
        results[i].maxCharacters = Math.max(1, ...await Promise.all(space.rectangles.map(b => figureCapacity(floor, b, lang, regions[i].weight === "bold"))));
        const fitted = free ? await fitLabel(labels[i]!, regions[i], ink.box, space.rectangles, expandedSizes[i] ?? sizes[i],
          alignment(i, free), lang, colors[i], floor, images) : null;
        if (fitted && !overlaps(fitted.position) && !ink.points.some(p => occupied.some(b => inside(b, p % info.width, Math.floor(p / info.width))))) {
          if (paint(i, space, fitted, layout)) continue;
        }
        if (!final) continue;
      }
      if (!ink.points.length) continue;
      const window = figureSpaceWindow(ink.box, info.width, info.height);
      if (ink.box.width > window.width || ink.box.height > window.height) continue;
      const otherText = [...boxes.filter((_, j) => j !== index), ...layout.filter((_, j) => j !== index).map(m => m.box)];
      const obstacles = [...otherText, ...occupied];
      const forbidden = obstacles.map(b => ({ left: b.left - 2, top: b.top - 2, width: b.width + 4, height: b.height + 4 }));
      const fallback = expanded ? undefined : fallbackSurfaces[i];
      const surface = fallback?.surface ?? layoutContext.surfaces?.[index];
      const bounds = layoutContext.bounds?.[index] ?? surface?.bounds;
      const fringe = FIGURE_SPACE.glyphFringe;
      const erase = fallback?.erase ?? { left: Math.max(0, ink.box.left - fringe), top: Math.max(0, ink.box.top - fringe),
        width: Math.min(info.width, ink.box.left + ink.box.width + fringe) - Math.max(0, ink.box.left - fringe),
        height: Math.min(info.height, ink.box.top + ink.box.height + fringe) - Math.max(0, ink.box.top - fringe) };
      const removable = figureEraseMask(info.width, info.height, index, layout, erase, bounds, eraseGuards[i]);
      if (!figureInkIsRemovable(ink, info.width, removable, erase) ||
          ink.points.some(p => otherText.some(b => inside(b, p % info.width, Math.floor(p / info.width))))) {
        rejectInk(i);
        continue;
      }
      if (ink.points.some(p => occupied.some(b => inside(b, p % info.width, Math.floor(p / info.width))))) continue;
      const space = prepareFigureOverlap(data, info.width, info.height, index, layout, forbidden, surface, bounds);
      if (!space) continue;
      const fitted = await fitOverlap(labels[i]!, regions[i], lang, colors[i], floor, space, alignment(i, window));
      if (!fitted) continue;
      const eraseObstacles = obstacles.filter(b => b.left < erase.left + erase.width && erase.left < b.left + b.width && b.top < erase.top + erase.height && erase.top < b.top + b.height);
      const restored = figureOverlapBackground(figureBackgroundPatch(data, info.width, info.height, erase, ink, surface), erase, removable, surface, eraseObstacles);
      for (let y = 0; y < erase.height; y++) for (let x = 0; x < erase.width; x++) {
        if (!removable[y * erase.width + x] || eraseObstacles.some(b => inside(b, erase.left + x, erase.top + y))) continue;
        restored.copy(painted, ((erase.top + y) * info.width + erase.left + x) * 4, (y * erase.width + x) * 4, (y * erase.width + x + 1) * 4);
      }
      const glyphs = figureOverlapTreatment(fitted.text, fitted.position.width, fitted.position.height, fitted.position, background(data, info.width, info.height, ink.box), surface);
      const input = await sharp(glyphs, { raw: { width: fitted.position.width, height: fitted.position.height, channels: 4 } }).png().toBuffer();
      occupied.push(fitted.position);
      overlays.push({ input, left: fitted.position.left, top: fitted.position.top });
      results[i].status = "rendered"; results[i].reason = null;
    }
    if (!overlays.length) return { bytes: null, results };
    const out = await sharp(painted, { raw: { width: info.width, height: info.height, channels: 4 } }).composite(overlays).webp({ lossless: true }).toBuffer();
    if (out.length > MEDIA_LIMITS.storedBytes) {
      for (const result of results) if (result.status === "rendered") { result.status = "external"; result.reason = "image_too_large"; }
      return { bytes: null, results };
    }
    return { bytes: out, results };
  };
}
