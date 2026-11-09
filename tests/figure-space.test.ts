import sharp from "sharp";
import { expect, it } from "vitest";
import type { FigureReading, FigureRegion } from "~/lib/figure";
import { FIGURE_SPACE, figureBox, figureEraseMask, figureSpaceWindow, figureRectangles, figureSpace, measureFigure, restoreFigureBackground } from "~/lib/figure-space.server";
import { figureFontSize, renderFigureLabels } from "~/lib/figure-render.server";

const label: FigureRegion = { text: "HHH", lang: "en", confidence: 1, x: .1, y: .2, width: .2, height: .2, orientation: "horizontal" };
const reading = (regions = [label]): FigureReading => ({ lang: "en", confidence: 1, regions });
const image = (width = 400, height = 200) => sharp({ create: { width, height, channels: 4, background: "white" } });

it.each([
  { left: 10, top: 20, width: 10, height: 20 }, { left: 40, top: 20, width: 10, height: 20 },
  { left: 20, top: 10, width: 20, height: 10 }, { left: 20, top: 40, width: 20, height: 10 },
])("protects touching neighbouring glyph boxes during erasure: %j", neighbour => {
  const box = { left: 20, top: 20, width: 20, height: 20 };
  const ink = { box, points: [20 * 80 + 20, 39 * 80 + 39], lineCount: 1, lineHeights: [20], uncertain: false };
  const mask = figureEraseMask(80, 60, 0, [ink, { ...ink, box: neighbour, points: [] }]);
  for (let y = neighbour.top; y < neighbour.top + neighbour.height; y++) for (let x = neighbour.left; x < neighbour.left + neighbour.width; x++) expect(mask[y * 80 + x]).toBe(0);
});

it("finds the largest anchored rectangle across aspect ratios, matching exhaustive search", () => {
  let state = 17;
  const random = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; };
  for (let k = 0; k < 100; k++) {
    const w = 6, h = 5, mask = Uint8Array.from({ length: w * h }, () => random() > .25 ? 1 : 0);
    const anchor = { left: 2, top: 2, width: 1 + k % 2, height: 1 };
    let expected = 0;
    for (let l = 0; l <= anchor.left; l++) for (let t = 0; t <= anchor.top; t++) for (let r = anchor.left + anchor.width; r <= w; r++) for (let b = anchor.top + anchor.height; b <= h; b++) {
      let valid = true;
      for (let y = t; y < b; y++) for (let x = l; x < r; x++) valid &&= Boolean(mask[y * w + x]);
      if (valid) expected = Math.max(expected, (r - l) * (b - t));
    }
    const largest = figureRectangles(mask, w, h, anchor)[0];
    expect(largest ? largest.width * largest.height : 0).toBe(expected);
  }
});

it("tolerates compression noise but stops at a visible low-contrast rule", () => {
  const width = 80, height = 50, data = Buffer.alloc(width * height * 4, 255);
  for (let y = 0; y < height; y++) for (let c = 0; c < 3; c++) data[(y * width + 60) * 4 + c] = 225;
  for (let c = 0; c < 3; c++) data[(25 * width + 25) * 4 + c] = 242;
  const measured = [{ box: { left: 20, top: 20, width: 20, height: 12 }, points: [], lineCount: 0, lineHeights: [], uncertain: false }];
  const space = figureSpace(data, width, height, 0, measured);
  expect(space.rectangles[0].width).toBeGreaterThan(40);
  expect(space.mask[25 * width + 25]).toBe(1);
  expect(space.mask[25 * width + 65]).toBe(0);
});

it("measures shifted glyphs and pixel lines when OCR omitted a line break", async () => {
  const bytes = await image().composite([{ input: { text: { text: "HHH\nHHH", font: "Noto Sans 24", rgba: true } }, left: 38, top: 38 }]).png().toBuffer();
  const { data } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
  const source = { ...label, text: "HHH HHH", width: .3, height: .4 };
  const ink = measureFigure(data, 400, 200, reading([source]))[0];
  expect(ink.box.left).toBe(38); expect(ink.box.top).toBe(38);
  expect(ink.lineCount).toBe(2);
  expect(await figureFontSize(source, ink)).toBeGreaterThanOrEqual(22);
  expect(await figureFontSize(source, ink)).toBeLessThanOrEqual(26);
  const erased = figureEraseMask(400, 200, 0, [ink]);
  expect(ink.points.every(p => erased[p] === 1)).toBe(true);
});

it("follows gradients past isolated star points while protecting panel rules and foreign text", async () => {
  const width = 200, height = 100, data = Buffer.alloc(width * height * 4, 255);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let c = 0; c < 3; c++) data[(y * width + x) * 4 + c] = x === 160 ? 0 : 80 + x;
  for (const x of [70, 100, 130]) for (let c = 0; c < 3; c++) data[(40 * width + x) * 4 + c] = 255;
  const anchor = { left: 20, top: 35, width: 25, height: 15 };
  const foreign = { left: 115, top: 70, width: 25, height: 15 };
  const ink = [anchor, foreign].map(box => ({ box, points: [], lineCount: 0, lineHeights: [], uncertain: false }));
  const space = figureSpace(data, width, height, 0, ink);
  expect(space.mask[40 * width + 100]).toBe(1);
  expect(space.mask[40 * width + 180]).toBe(0);
  expect(space.mask[75 * width + 120]).toBe(0);
  expect(space.rectangles[0].width).toBeGreaterThan(100);
  const restored = restoreFigureBackground(data, width, height, anchor);
  for (let y = anchor.top; y < anchor.top + anchor.height; y++) for (let x = anchor.left; x < anchor.left + anchor.width; x++) {
    expect(Math.abs(restored[(y * width + x) * 4] - data[(y * width + x) * 4])).toBeLessThanOrEqual(1);
  }
});

it("allocates the unused gap to a longer translation while preserving its neighbour", async () => {
  const other = { ...label, text: "I", x: .75, width: .1, lang: "ja" as const };
  const bytes = await image().composite([{ input: { create: { width: 40, height: 40, channels: 4, background: "black" } }, left: 300, top: 40 }]).png().toBuffer();
  const out = await renderFigureLabels(bytes, reading([label, other]), ["HHH HHH HHH"], "en");
  expect(out.results[0].status).toBe("rendered");
  const raw = await sharp(out.bytes!).ensureAlpha().raw().toBuffer(), original = await sharp(bytes).ensureAlpha().raw().toBuffer();
  const darkBeyondMidpoint = Array.from({ length: 80 * 40 }, (_, i) => raw[((40 + Math.floor(i / 80)) * 400 + 200 + i % 80) * 4] < 128).some(Boolean);
  expect(darkBeyondMidpoint).toBe(true);
  for (let y = 38; y < 82; y++) expect(raw.subarray((y * 400 + 298) * 4, (y * 400 + 342) * 4)).toEqual(original.subarray((y * 400 + 298) * 4, (y * 400 + 342) * 4));
});

it("keeps failed labels untouched while rendering successful labels and recording fit dimensions", async () => {
  const first = { ...label, text: "H", x: .1, width: .1, height: .15 };
  const second = { ...label, text: "H", x: .7, width: .1, height: .15 };
  const source = reading([first, second]);
  const bytes = await image().composite([first, second].map(r => ({ input: { text: { text: "H", font: "Noto Sans 24", rgba: true } }, left: Math.floor(r.x * 400), top: 40 }))).png().toBuffer();
  const out = await renderFigureLabels(bytes, source, ["Good", "Long word ".repeat(150)], "en");
  expect(out.results[0].status).toBe("rendered");
  expect(out.results[1]).toMatchObject({ status: "external", reason: "does_not_fit", translation: "Long word ".repeat(150), required: { width: expect.any(Number), height: expect.any(Number) }, available: { width: expect.any(Number), height: expect.any(Number) }, maxCharacters: expect.any(Number) });
  const raw = await sharp(out.bytes!).ensureAlpha().raw().toBuffer(), original = await sharp(bytes).ensureAlpha().raw().toBuffer();
  const box = figureBox(second, 400, 200);
  for (let y = box.top; y < box.top + box.height; y++) expect(raw.subarray((y * 400 + box.left) * 4, (y * 400 + box.left + box.width) * 4)).toEqual(original.subarray((y * 400 + box.left) * 4, (y * 400 + box.left + box.width) * 4));
});

it("records every failure even when no label can be drawn", async () => {
  const bytes = await image().png().toBuffer();
  const out = await renderFigureLabels(bytes, reading([label, { ...label, text: "∂ K(w)", y: .6 }]), ["x".repeat(1900), "d K(w)"], "en");
  expect(out.bytes).toBeNull();
  expect(out.results.map(r => r.reason)).toEqual(["does_not_fit", "math_mismatch"]);
});

it.each([[2, false], [3, false], [2, true]] as const)("preserves a %ipx enclosure six pixels from glyphs (OCR includes frame: %s)", async (stroke, includesFrame) => {
  const width = 600, height = 300, left = 100, top = 100, gap = 6;
  const glyph = await sharp({ text: { text: "入力データ", font: "Noto Sans CJK JP 24", rgba: true } }).png().toBuffer({ resolveWithObject: true });
  const w = glyph.info.width, h = glyph.info.height;
  const frame = `<svg width="${width}" height="${height}"><rect x="${left - gap - stroke / 2}" y="${top - gap - stroke / 2}" width="${w + gap * 2 + stroke}" height="${h + gap * 2 + stroke}" fill="none" stroke="black" stroke-width="${stroke}"/></svg>`;
  const marks = await image(width, height).composite([{ input: Buffer.from(frame) }]).png().toBuffer();
  const bytes = await sharp(marks).composite([{ input: glyph.data, left, top }]).png().toBuffer();
  const margin = includesFrame ? gap + stroke + 2 : 0;
  const source = reading([{ ...label, lang: "ja", text: "入力データ", x: (left - margin) / width, y: (top - margin) / height, width: (w + margin * 2) / width, height: (h + margin * 2) / height }]); source.lang = "ja";
  const data = await sharp(bytes).ensureAlpha().raw().toBuffer(), ink = measureFigure(data, width, height, source);
  expect(ink[0].box.left).toBeGreaterThanOrEqual(left); expect(ink[0].box.top).toBeGreaterThanOrEqual(top);
  expect(ink[0].box.left + ink[0].box.width).toBeLessThanOrEqual(left + w);
  expect(ink[0].box.top + ink[0].box.height).toBeLessThanOrEqual(top + h);
  expect(ink[0].protectedPoints!.length).toBeGreaterThan(100);
  const mask = figureEraseMask(width, height, 0, ink), protectedPixels = await sharp(marks).ensureAlpha().raw().toBuffer();
  const rendered = await renderFigureLabels(bytes, source, ["I"], "en");
  expect(rendered.results[0].status).toBe("rendered");
  const out = await sharp(rendered.bytes!).ensureAlpha().raw().toBuffer();
  for (let p = 0; p < width * height; p++) if (protectedPixels[p * 4] < 128) {
    expect(mask[p]).toBe(0); expect(out.subarray(p * 4, p * 4 + 4)).toEqual(data.subarray(p * 4, p * 4 + 4));
  }
});

it("preserves an arrowhead beside the label with readable clearance", async () => {
  const width = 600, height = 300, left = 100, top = 100;
  const glyph = await sharp({ text: { text: "HHH", font: "Noto Sans 32", rgba: true } }).png().toBuffer({ resolveWithObject: true });
  const w = glyph.info.width, h = glyph.info.height, arrowLeft = left + w + 14;
  const arrow = Buffer.from(`<svg width="${width}" height="${height}"><path d="M ${arrowLeft} ${top} l 16 ${h / 2} l -16 ${h / 2} Z" fill="black"/></svg>`);
  const marks = await image(width, height).composite([{ input: arrow }]).png().toBuffer();
  const bytes = await sharp(marks).composite([{ input: glyph.data, left, top }]).png().toBuffer();
  const source = reading([{ ...label, x: left / width, y: top / height, width: w / width, height: h / height }]);
  const data = await sharp(bytes).ensureAlpha().raw().toBuffer(), ink = measureFigure(data, width, height, source);
  expect(ink[0].box).toEqual({ left, top, width: w, height: h });
  const rendered = await renderFigureLabels(bytes, source, ["I"], "en");
  expect(rendered.results[0].status).toBe("rendered");
  const out = await sharp(rendered.bytes!).ensureAlpha().raw().toBuffer();
  for (let y = top - 2; y < top + h + 2; y++) for (let x = arrowLeft - 2; x < arrowLeft + 18; x++) {
    const p = (y * width + x) * 4; expect(out.subarray(p, p + 4)).toEqual(data.subarray(p, p + 4));
  }
});

it.each([
  { shape: "rectangle", stroke: 2, gap: 5, external: false },
  { shape: "rectangle", stroke: 2, gap: 4 },
  { shape: "rectangle", stroke: 3, gap: 6 },
  { shape: "rectangle", stroke: 3, gap: 5 },
  { shape: "rounded", stroke: 2, gap: 6 },
  { shape: "rounded", stroke: 2, gap: 5 },
  { shape: "underline", stroke: 2, gap: 4 },
  { shape: "underline", stroke: 2, gap: 3 },
  { shape: "ellipse", stroke: 2, gap: 20 },
  { shape: "ellipse", stroke: 2, gap: 16 },
])("renders or retains source inside a nearby $shape while preserving its pixels (stroke $stroke, gap $gap)", async ({ shape, stroke, gap, external = false }) => {
  const width = 600, height = 300, left = 100, top = 100;
  const glyph = await sharp({ text: { text: "入力データ", font: "Noto Sans CJK JP 28", rgba: true } }).png().toBuffer({ resolveWithObject: true });
  const w = glyph.info.width, h = glyph.info.height;
  const outline = shape === "ellipse"
    ? `<ellipse cx="${left + w / 2}" cy="${top + h / 2}" rx="${w / 2 + gap + stroke / 2}" ry="${h / 2 + gap + stroke / 2}"/>`
    : shape === "underline"
      ? `<path d="M ${left - gap} ${top + h + gap + stroke / 2} H ${left + w + gap}"/>`
      : `<rect x="${left - gap - stroke / 2}" y="${top - gap - stroke / 2}" width="${w + gap * 2 + stroke}" height="${h + gap * 2 + stroke}" rx="${shape === "rounded" ? (gap === 6 ? 12 : 8) : 0}"/>`;
  const marks = await image(width, height).composite([{ input: Buffer.from(`<svg width="${width}" height="${height}"><g fill="none" stroke="black" stroke-width="${stroke}">${outline}</g></svg>`) }]).png().toBuffer();
  const bytes = await sharp(marks).composite([{ input: glyph.data, left, top }]).png().toBuffer();
  const source = reading([{ ...label, text: "入力データ", lang: "ja", x: left / width, y: top / height, width: w / width, height: h / height }]); source.lang = "ja";
  const result = await renderFigureLabels(bytes, source, ["Input data"], "en");
  if (external) {
    expect(result.bytes).toBeNull();
    expect(result.results[0]).toMatchObject({ status: "external", reason: "does_not_fit" });
    return;
  }
  expect(result.results[0].status).toBe("rendered");
  const original = await sharp(bytes).ensureAlpha().raw().toBuffer(), out = await sharp(result.bytes!).ensureAlpha().raw().toBuffer();
  const protectedPixels = await sharp(marks).ensureAlpha().raw().toBuffer();
  let changed = 0;
  for (let p = 0; p < width * height; p++) {
    if (protectedPixels[p * 4] < 255) expect(out.subarray(p * 4, p * 4 + 4)).toEqual(original.subarray(p * 4, p * 4 + 4));
    if (out[p * 4] !== original[p * 4]) changed++;
  }
  expect(changed).toBeGreaterThan(100);
});

it("retains source when a protected rule prevents safe glyph erasure", async () => {
  const glyph = await sharp({ text: { text: "HHH", font: "Noto Sans 28", rgba: true } }).png().toBuffer({ resolveWithObject: true });
  const width = 400, height = 200, left = 40, top = 40;
  const bytes = await image().composite([
    { input: glyph.data, left, top },
    { input: { create: { width: glyph.info.width + 4, height: 2, channels: 4 as const, background: "black" } }, left: left - 2, top: top + glyph.info.height + 1 },
  ]).png().toBuffer();
  const result = await renderFigureLabels(bytes, reading([{ ...label, x: left / width, y: top / height, width: glyph.info.width / width, height: glyph.info.height / height }]), ["Data"], "en");
  expect(result.bytes).toBeNull();
  expect(result.results[0]).toMatchObject({ status: "external", reason: "does_not_fit" });
});

it("bounds the search raster and retains global coordinates away from the image origin", () => {
  const width = 2000, height = 1500, box = { left: 1400, top: 1000, width: 80, height: 24 };
  const measured = [{ box, points: [], lineCount: 0, lineHeights: [], uncertain: false }];
  const space = figureSpace(Buffer.alloc(width * height * 4, 255), width, height, 0, measured);
  expect(space.window.left).toBeGreaterThan(0); expect(space.window.top).toBeGreaterThan(0);
  expect(space.mask.length).toBe(space.window.width * space.window.height);
  expect(space.mask.length).toBeLessThanOrEqual(FIGURE_SPACE.maxWindowPixels);
  const rect = space.rectangles[0];
  expect(rect.left).toBeLessThanOrEqual(box.left); expect(rect.top).toBeLessThanOrEqual(box.top);
  expect(rect.left + rect.width).toBeGreaterThanOrEqual(box.left + box.width);
  expect(rect.top + rect.height).toBeGreaterThanOrEqual(box.top + box.height);
  const large = figureSpaceWindow({ left: 0, top: 0, width, height }, width, height);
  expect(large.width * large.height).toBeLessThanOrEqual(FIGURE_SPACE.maxWindowPixels);
});
