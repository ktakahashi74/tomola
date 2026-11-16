import sharp from "sharp";
import { afterEach, expect, it, vi } from "vitest";
import { FIGURE_OVERLAP, figureOverlapBackground, figureOverlapPosition, figureOverlapTreatment, prepareFigureOverlap } from "~/lib/figure-overlap.server";
import * as overlap from "~/lib/figure-overlap.server";
import * as space from "~/lib/figure-space.server";
import { createFigureRenderer, renderFigureLabels } from "~/lib/figure-render.server";
import type { FigureReading } from "~/lib/figure";

afterEach(() => vi.restoreAllMocks());

it.each([1, 2])("covers widespread restoration streaks while retaining the exact deviation boundary: %i", different => {
  const box = { left: 10, top: 20, width: 12, height: 1 };
  const surface = { box, channels: [[20, 0, 0], [30, 0, 0], [40, 0, 0], [255, 0, 0]] };
  const patch = Buffer.concat(Array.from({ length: 12 }, () => Buffer.from([20, 30, 40, 255])));
  for (let p = 0; p <= different; p++) patch[p * 4] = 100;
  patch[11 * 4] = 100;
  const original = Buffer.from(patch), mask = new Uint8Array(12).fill(1);
  mask[11] = 0;
  const restored = figureOverlapBackground(patch, box, mask, surface, [{ left: 10, top: 20, width: 1, height: 1 }]);
  expect(patch).toEqual(original);
  expect(restored.subarray(0, 4)).toEqual(original.subarray(0, 4));
  expect(restored.subarray(44)).toEqual(original.subarray(44));
  for (let p = 1; p <= 10; p++) expect(restored.subarray(p * 4, p * 4 + 4)).toEqual(different === 1 ? original.subarray(p * 4, p * 4 + 4) : Buffer.from([20, 30, 40, 255]));
  expect(figureOverlapBackground(patch, box, mask)).toBe(patch);
});

const width = 160, height = 80;
const anchor = { left: 50, top: 30, width: 60, height: 20 };
const measured = [{ box: anchor, points: [], lineCount: 1, lineHeights: [20], uncertain: false }];

it("never places a fallback across another text box, even with unrestricted graphic overlap", () => {
  const data = Buffer.alloc(width * height * 4, 255);
  const forbidden = { left: 78, top: 0, width: 4, height };
  const space = prepareFigureOverlap(data, width, height, 0, measured, [forbidden])!;
  expect(figureOverlapPosition(space, 70, 20, 1)).toBeNull();
  const adjacent = prepareFigureOverlap(data, width, height, 0, measured, [{ left: 0, top: 0, width: 45, height }])!;
  const placed = figureOverlapPosition(adjacent, 70, 20, 0)!;
  expect(placed.position.left).toBeGreaterThanOrEqual(45);
  expect(placed.pixels).toBe(0);
});

it("rejects every placement above the graphic overlap ceiling and accepts its exact boundary", () => {
  const data = Buffer.alloc(width * height * 4, 255);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x += 4) data.set([0, 0, 0, 255], (y * width + x) * 4);
  const space = prepareFigureOverlap(data, width, height, 0, measured, [])!;
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
  const context = space.prepareFigureSpace;
  vi.spyOn(space, "prepareFigureSpace").mockImplementation((...args) => ({ ...context(...args), surfaces: [{
    box: args[2][0].box, channels: [[20, 0, 0], [30, 0, 0], [40, 0, 0], [255, 0, 0]],
  }] }));
  vi.spyOn(space, "figureBackgroundPatchAgrees").mockReturnValue(false);
  try {
    FIGURE_OVERLAP.maxRatio = 0;
    const rejected = await renderFigureLabels(source, reading, ["W".repeat(14)], "en");
    expect(rejected.results[0]).toMatchObject({ status: "external", reason: "does_not_fit" });
    FIGURE_OVERLAP.maxRatio = .2;
    const render = await createFigureRenderer(source, reading, "en");
    const deferred = await render(["W".repeat(14)], { final: false });
    expect(deferred.results[0].status).toBe("external");
    expect(prepare).toHaveBeenCalledTimes(1);
    const accepted = await render(["W".repeat(14)], { final: true });
    expect(accepted.results[0].status).toBe("rendered");
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(prepare.mock.calls[1][5]).toContainEqual({ left: 208, top: -2, width: 44, height: 184 });
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

it("prefers a source edge over a lower-overlap shifted placement and keeps the source margin", () => {
  const data = Buffer.alloc(width * height * 4, 255);
  const edge = { ...anchor, left: 12, width: 80 };
  for (let y = 25; y < 55; y++) data.set([0, 0, 0, 255], (y * width + 14) * 4);
  const prepared = prepareFigureOverlap(data, width, height, 0, [{ ...measured[0], box: edge }], [])!;
  const placed = figureOverlapPosition(prepared, 90, 24, .1, "left")!;
  expect(placed.position.left).toBe(edge.left + 1);
  expect(placed.aligned).toBe(true);
  expect(placed.pixels).toBeGreaterThan(0);
  const blocked = { ...prepared, obstacles: [{ left: 13, top: 0, width: 2, height }] };
  const moved = figureOverlapPosition(blocked, 90, 24, .1, "left")!;
  expect(moved.aligned).toBe(false);
  expect(moved.position.left).toBeGreaterThanOrEqual(edge.left);
});

it("keeps source erasure inside its backing while allowing local color restoration to differ from the placement model", () => {
  const data = Buffer.alloc(width * height * 4, 255), point = 35 * width + 55;
  data.set([0, 0, 0, 255], point * 4);
  const ink = [{ ...measured[0], points: [point] }];
  expect(prepareFigureOverlap(data, width, height, 0, ink, [], undefined, { left: 60, top: 30, width: 50, height: 20 })).toBeNull();
  const model = { box: anchor, channels: [[230, 0, 0], [230, 0, 0], [230, 0, 0], [255, 0, 0]] };
  const patch = space.figureBackgroundPatch(data, width, height, anchor, ink[0], model);
  expect(space.figureBackgroundPatchAgrees(patch, anchor, width, ink[0], model)).toBe(false);
  expect(prepareFigureOverlap(data, width, height, 0, ink, [], model)).not.toBeNull();
  expect(prepareFigureOverlap(data, width, height, 0, ink, [], model, { left: 60, top: 30, width: 50, height: 20 })).toBeNull();
});


it("retains nearby shifted candidates when the source edge cannot accommodate a wider label", () => {
  const ink = [{ ...measured[0], box: { left: 60, top: 30, width: 40, height: 20 } }];
  const data = Buffer.alloc(width * height * 4, 255);
  const prepared = prepareFigureOverlap(data, width, height, 0, ink, [{ left: 130, top: 0, width: 5, height }])!;
  const placed = figureOverlapPosition(prepared, 90, 24, .1, "left")!;
  expect(placed.aligned).toBe(false);
  expect(placed.position.left + placed.position.width).toBeLessThanOrEqual(130);
});
