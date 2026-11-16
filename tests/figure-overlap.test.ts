import sharp from "sharp";
import { afterEach, expect, it, vi } from "vitest";
import { FIGURE_OVERLAP, figureOverlapPosition, figureOverlapTreatment, prepareFigureOverlap } from "~/lib/figure-overlap.server";
import * as overlap from "~/lib/figure-overlap.server";
import * as space from "~/lib/figure-space.server";
import { renderFigureLabels } from "~/lib/figure-render.server";
import type { FigureReading } from "~/lib/figure";

afterEach(() => vi.restoreAllMocks());

const width = 160, height = 80;
const anchor = { left: 50, top: 30, width: 60, height: 20 };
const measured = [{ box: anchor, points: [], lineCount: 1, lineHeights: [20], uncertain: false }];

it("never places a fallback across another text box, even with unrestricted graphic overlap", () => {
  const data = Buffer.alloc(width * height * 4, 255);
  const forbidden = { left: 78, top: 0, width: 4, height };
  const space = prepareFigureOverlap(data, width, height, 0, measured, [forbidden]);
  expect(figureOverlapPosition(space, 70, 20, 1)).toBeNull();
  const adjacent = prepareFigureOverlap(data, width, height, 0, measured, [{ left: 0, top: 0, width: 45, height }]);
  const placed = figureOverlapPosition(adjacent, 70, 20, 0)!;
  expect(placed.position.left).toBeGreaterThanOrEqual(45);
  expect(placed.pixels).toBe(0);
});

it("rejects every placement above the graphic overlap ceiling and accepts its exact boundary", () => {
  const data = Buffer.alloc(width * height * 4, 255);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x += 4) data.set([0, 0, 0, 255], (y * width + x) * 4);
  const space = prepareFigureOverlap(data, width, height, 0, measured, []);
  expect(figureOverlapPosition(space, 64, 24, .2)).toBeNull();
  const placed = figureOverlapPosition(space, 64, 24, .25)!;
  expect(placed.pixels).toBe(64 * 24 / 4);
  expect(placed.ratio).toBe(.25);
});

it("leaves successful ordinary rendering independent of the fallback ceiling", async () => {
  const text = "H".repeat(4);
  const glyph = await sharp({ text: { text, font: "Noto Sans 20", rgba: true } }).png().toBuffer({ resolveWithObject: true });
  const source = await sharp({ create: { width: 400, height: 160, channels: 4, background: "white" } }).composite([{ input: glyph.data, left: 80, top: 60 }]).png().toBuffer();
  const reading: FigureReading = { lang: "en", confidence: 1, regions: [{ text, lang: "en", confidence: 1, orientation: "horizontal", x: .2, y: 60 / 160, width: glyph.info.width / 400, height: glyph.info.height / 160 }] };
  const prepare = vi.spyOn(overlap, "prepareFigureOverlap");
  const saved = FIGURE_OVERLAP.maxRatio;
  try {
    FIGURE_OVERLAP.maxRatio = 0;
    const before = await renderFigureLabels(source, reading, ["M".repeat(4)], "en");
    FIGURE_OVERLAP.maxRatio = 1;
    const after = await renderFigureLabels(source, reading, ["M".repeat(4)], "en");
    expect(before.results[0].status).toBe("rendered");
    expect(after.results).toEqual(before.results);
    expect(after.bytes).toEqual(before.bytes);
    expect(prepare).not.toHaveBeenCalled();
  } finally { FIGURE_OVERLAP.maxRatio = saved; }
});

it("keeps the halo within its checked footprint and hides fewer pixels than the backing", () => {
  const glyphs = Buffer.alloc(9 * 9 * 4);
  for (let y = 3; y < 6; y++) glyphs.set([255, 255, 255, 255], (y * 9 + 4) * 4);
  const position = { left: 10, top: 10, width: 9, height: 9 };
  const halo = figureOverlapTreatment(glyphs, 9, 9, position, [20, 20, 20, 255], undefined, "halo");
  const backing = figureOverlapTreatment(glyphs, 9, 9, position, [20, 20, 20, 255], undefined, "backing");
  const count = (data: Buffer) => Array.from({ length: 81 }, (_, p) => data[p * 4 + 3]).filter(Boolean).length;
  expect(count(halo)).toBe(15);
  expect(count(backing)).toBe(81);
  for (let p = 0; p < 81; p++) if (glyphs[p * 4 + 3]) expect(halo.subarray(p * 4, p * 4 + 4)).toEqual(glyphs.subarray(p * 4, p * 4 + 4));
});

it("applies the ceiling to actual fallback rendering while preserving a neighbouring text box", async () => {
  const w = 320, h = 180, text = "H".repeat(5);
  const glyph = await sharp({ text: { text: `<span foreground="white">${text}</span>`, font: "Noto Sans 18", rgba: true } }).png().toBuffer({ resolveWithObject: true });
  const pixels = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const own = x >= 112 && x < 128 + glyph.info.width && y >= 67 && y < 83 + glyph.info.height;
    pixels.set(!own && y % 7 === 0 ? [80, 65, 100, 255] : [20, 30, 40, 255], (y * w + x) * 4);
  }
  const source = await sharp(pixels, { raw: { width: w, height: h, channels: 4 } }).composite([{ input: glyph.data, left: 120, top: 75 }]).png().toBuffer();
  const reading: FigureReading = { lang: "en", confidence: 1, regions: [{ text, lang: "en", confidence: 1, orientation: "horizontal", x: 120 / w, y: 75 / h, width: glyph.info.width / w, height: glyph.info.height / h }],
    protectedBoxes: [{ x: 210 / w, y: 0, width: 40 / w, height: 1 }] };
  const saved = FIGURE_OVERLAP.maxRatio, prepare = vi.spyOn(overlap, "prepareFigureOverlap"), position = vi.spyOn(overlap, "figureOverlapPosition");
  const ordinary = space.figureSpace;
  vi.spyOn(space, "figureSpace").mockImplementation((...args) => ({ ...ordinary(...args), rectangles: [] }));
  vi.spyOn(space, "figureSurfaceSpace").mockReturnValue(undefined);
  try {
    FIGURE_OVERLAP.maxRatio = 0;
    const rejected = await renderFigureLabels(source, reading, ["W".repeat(14)], "en");
    expect(rejected.results[0]).toMatchObject({ status: "external", reason: "does_not_fit" });
    FIGURE_OVERLAP.maxRatio = .2;
    const accepted = await renderFigureLabels(source, reading, ["W".repeat(14)], "en");
    expect(accepted.results[0].status).toBe("rendered");
    expect(prepare).toHaveBeenCalledTimes(2);
    const placements = position.mock.results.filter(r => r.type === "return" && r.value).map(r => r.value);
    expect(placements.length).toBeGreaterThan(0);
    for (const p of placements) {
      expect(p.ratio).toBeLessThanOrEqual(.2);
      expect(p.position.left + p.position.width).toBeLessThanOrEqual(210);
    }
    const rendered = await sharp(accepted.bytes!).ensureAlpha().raw().toBuffer();
    const original = await sharp(source).ensureAlpha().raw().toBuffer();
    for (let y = 0; y < h; y++) expect(rendered.subarray((y * w + 210) * 4, (y * w + 250) * 4)).toEqual(original.subarray((y * w + 210) * 4, (y * w + 250) * 4));
  } finally { FIGURE_OVERLAP.maxRatio = saved; }
});
