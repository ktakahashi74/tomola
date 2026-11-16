import sharp from "sharp";
import { expect, it } from "vitest";
import type { FigureReading, FigureRegion } from "~/lib/figure";
import { FIGURE_MIN_FONT_SCALE, figureCapacity, figureFontSize, renderFigureLabels } from "~/lib/figure-render.server";
import { FIGURE_SPACE, figureSpace, figureSpaceWindow, figureSurfaceSpace, measureFigure, prepareFigureSpace } from "~/lib/figure-space.server";

const reading = (text: string, box: { left: number; top: number; width: number; height: number }, width: number, height: number, lang: "en" | "ja" = "en"): FigureReading => ({
  lang, confidence: 1, regions: [{ text, lang, confidence: 1, orientation: "horizontal", x: box.left / width, y: box.top / height, width: box.width / width, height: box.height / height } satisfies FigureRegion],
});
const raw = (bytes: Buffer) => sharp(bytes).ensureAlpha().raw().toBuffer();
async function unchanged(before: Buffer, after: Buffer, width: number, box: { left: number; top: number; width: number; height: number }) {
  const a = await raw(before), b = await raw(after);
  for (let y = box.top; y < box.top + box.height; y++) expect(b.subarray((y * width + box.left) * 4, (y * width + box.left + box.width) * 4)).toEqual(a.subarray((y * width + box.left) * 4, (y * width + box.left + box.width) * 4));
}

it.each([{ count: 8, translated: 10 }, { count: 14, translated: 21 }])("fits longer white text within a filled banner on white with $count source glyphs", async ({ count, translated }) => {
  const text = "山".repeat(count);
  const glyph = await sharp({ text: { text: `<span foreground="white">${text}</span>`, font: "Noto Sans CJK JP 20", rgba: true } }).png().toBuffer({ resolveWithObject: true });
  const width = glyph.info.width + 100, height = 120;
  const banner = { left: 30, top: 40, width: glyph.info.width + 40, height: glyph.info.height + 16 };
  const pixels = Buffer.alloc(width * height * 4, 255);
  for (let y = banner.top; y < banner.top + banner.height; y++) for (let x = banner.left; x < banner.left + banner.width; x++) {
    pixels.set([23, 85, 200, 255], (y * width + x) * 4);
  }
  const source = await sharp(pixels, { raw: { width, height, channels: 4 } }).composite([{ input: glyph.data, left: 50, top: 48 }]).png().toBuffer();
  const input = reading(text, { left: 50, top: 48, width: glyph.info.width, height: glyph.info.height }, width, height, "ja");
  expect(glyph.info.width > 256).toBe(count === 14);
  const translation = "M".repeat(translated);
  const out = await renderFigureLabels(source, input, [translation], "en");
  expect(out.results[0].status).toBe("rendered");
  const a = await raw(source), b = await raw(out.bytes!);
  let changed = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = (y * width + x) * 4;
    if (a.subarray(p, p + 4).equals(b.subarray(p, p + 4))) continue;
    changed++;
    expect(x).toBeGreaterThanOrEqual(banner.left + 2);
    expect(x).toBeLessThan(banner.left + banner.width - 2);
    expect(y).toBeGreaterThanOrEqual(banner.top + 2);
    expect(y).toBeLessThan(banner.top + banner.height - 2);
  }
  expect(changed).toBeGreaterThan(0);
});

it("stops at a broad fill even when its soft edge connects to a known background gradient", () => {
  const width = 200, height = 80, pixels = Buffer.alloc(width * height * 4, 255);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const base = 50 + x / 3, fill = x >= 110 && x < 170 ? Math.min(80, y * 2) : 0;
    for (let c = 0; c < 3; c++) pixels[(y * width + x) * 4 + c] = Math.round(base + (c ? -fill / 2 : fill));
  }
  const box = { left: 30, top: 20, width: 30, height: 40 };
  const measured = [{ box, points: [], lineCount: 0, lineHeights: [], uncertain: false }];
  const surface = { box, channels: [[60, 10, 0], [60, 10, 0], [60, 10, 0], [255, 0, 0]] };
  const space = figureSpace(pixels, width, height, 0, measured, [], prepareFigureSpace(width, height, measured), FIGURE_SPACE.guard, surface);
  expect(space.mask[40 * width + 80]).toBe(1);
  expect(space.mask[40 * width + 135]).toBe(0);
});

it.each([0, 10])("renders on a smooth gradient with %i levels of fine texture while preserving an illustration", async noise => {
  const width = 520, height = 180, text = "H".repeat(13), pixels = Buffer.alloc(width * height * 4, 255);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let c = 0; c < 3; c++) pixels[(y * width + x) * 4 + c] = Math.round(Math.max(30, 170 - x * .4) + ((x * 17 + y * 31) % 7 - 3) * noise / 3);
  const fadingFill = noise ? '<defs><linearGradient id="fill" gradientUnits="userSpaceOnUse" x1="0" y1="54" x2="0" y2="110"><stop stop-color="#262626"/><stop offset="1" stop-color="#9c1818"/></linearGradient></defs><rect x="330" width="75" height="180" fill="url(#fill)"/>' : "";
  const marks = Buffer.from(`<svg width="${width}" height="${height}">${fadingFill}<path d="M0 50H405M0 110H405" stroke="black" stroke-width="4"/><rect x="405" width="115" height="180" fill="#a83824"/><circle cx="460" cy="80" r="32" fill="#357bae"/><path d="M425 140L480 115L500 160Z" fill="#efd34c"/></svg>`);
  const glyph = await sharp({ text: { text: `<span foreground="white">${text}</span>`, font: "Noto Sans 28", rgba: true } }).png().toBuffer({ resolveWithObject: true });
  const source = await sharp(pixels, { raw: { width, height, channels: 4 } }).composite([{ input: marks }, { input: glyph.data, left: 30, top: 65 }]).png().toBuffer();
  const out = await renderFigureLabels(source, reading(text, { left: 30, top: 65, width: glyph.info.width, height: glyph.info.height }, width, height), ["M".repeat(13)], "en");
  expect(out.results[0].status).toBe("rendered");
  await unchanged(source, out.bytes!, width, { left: 405, top: 0, width: 115, height });
  if (noise) await unchanged(source, out.bytes!, width, { left: 330, top: 0, width: 75, height });
  for (const top of [48, 108]) await unchanged(source, out.bytes!, width, { left: 0, top, width: 405, height: 4 });
});

it("keeps short text inside a shaded dark backing over patterned artwork and retains a longer label", async () => {
  const width = 360, height = 180, text = "H".repeat(9), pixels = Buffer.alloc(width * height * 4, 255);
  const backing = { left: 65, top: 70, width: 200, height: 30 };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const onBacking = x >= backing.left && x < backing.left + backing.width && y >= backing.top && y < backing.top + backing.height;
    const color = onBacking ? (x < 135 ? [26, 48, 50] : [80, 110, 113]) : ((Math.floor(x / 7) + Math.floor(y / 7)) % 2 ? [186, 141, 93] : [115, 170, 146]);
    for (let c = 0; c < 3; c++) pixels[(y * width + x) * 4 + c] = color[c];
  }
  const glyph = await sharp({ text: { text: `<span foreground="white">${text}</span>`, font: "Noto Sans 16", rgba: true } }).png().toBuffer({ resolveWithObject: true });
  const source = await sharp(pixels, { raw: { width, height, channels: 4 } }).composite([{ input: glyph.data, left: 80, top: 78 }]).png().toBuffer();
  const input = reading(text, { left: 76, top: 76, width: glyph.info.width + 8, height: glyph.info.height + 4 }, width, height);
  const out = await renderFigureLabels(source, input, ["山".repeat(5)], "ja");
  expect(out.results[0].status).toBe("rendered");
  for (const box of [{ left: 0, top: 0, width, height: backing.top }, { left: 0, top: 100, width, height: 80 }, { left: 0, top: 70, width: 65, height: 30 }, { left: 265, top: 70, width: 95, height: 30 }]) await unchanged(source, out.bytes!, width, box);
  const longer = await renderFigureLabels(source, input, ["M".repeat(80)], "fr");
  expect(longer.results[0]).toMatchObject({ status: "external", reason: "does_not_fit" });
  expect(longer.bytes).toBeNull();
});

it.each(["ja", "fr"] as const)("fits %s glyphs inside a shallow backing without changing its edges or artwork", async lang => {
  const width = 280, height = 120, text = "H".repeat(9), pixels = Buffer.alloc(width * height * 4, 255);
  const glyph = await sharp({ text: { text: `<span foreground="white">${text}</span>`, font: "Noto Sans 16", rgba: true } }).png().toBuffer({ resolveWithObject: true });
  const backing = { left: 50, top: 50, width: glyph.info.width + 28, height: glyph.info.height + 6 };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const onBacking = x >= backing.left && x < backing.left + backing.width && y >= backing.top && y < backing.top + backing.height;
    const color = onBacking ? [30, 48, 52] : (x + y) % 2 ? [190, 145, 100] : [110, 175, 150];
    for (let c = 0; c < 3; c++) pixels[(y * width + x) * 4 + c] = color[c];
  }
  const source = await sharp(pixels, { raw: { width, height, channels: 4 } }).composite([{ input: glyph.data, left: backing.left + 14, top: backing.top + 3 }]).png().toBuffer();
  const input = reading(text, { left: backing.left + 14, top: backing.top + 3, width: glyph.info.width, height: glyph.info.height }, width, height);
  const measured = measureFigure(await raw(source), width, height, input), size = await figureFontSize(input.regions[0], measured[0]);
  const translation = (lang === "ja" ? "山" : "É").repeat(lang === "ja" ? 6 : 9);
  const floor = Math.ceil(size * FIGURE_MIN_FONT_SCALE);
  const minimum = await sharp({ text: { text: translation, font: `${lang === "ja" ? "Noto Sans CJK JP" : "Noto Sans"} ${floor}`, rgba: true } }).metadata();
  expect(minimum.height! + 4).toBeGreaterThan(backing.height - 4);
  const out = await renderFigureLabels(source, input, [translation], lang);
  expect(out.results[0].status).toBe("rendered");
  expect(out.bytes).not.toBeNull();
  const a = await raw(source), b = await raw(out.bytes!);
  let changed = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = (y * width + x) * 4;
    if (a.subarray(p, p + 4).equals(b.subarray(p, p + 4))) continue;
    changed++;
    expect(x).toBeGreaterThanOrEqual(backing.left + 2);
    expect(x).toBeLessThan(backing.left + backing.width - 2);
    expect(y).toBeGreaterThanOrEqual(backing.top + 2);
    expect(y).toBeLessThan(backing.top + backing.height - 2);
  }
  expect(changed).toBeGreaterThan(0);
});

it("retains the larger ordinary-search budget when the surface search is more restrictive", async () => {
  const width = 480, height = 160, text = "H".repeat(8), pixels = Buffer.alloc(width * height * 4, 255);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let c = 0; c < 3; c++) pixels[(y * width + x) * 4 + c] = Math.round(50 + x / 3 + (x >= 250 ? (c ? -1 : 1) * Math.min(75, y * 2) : 0));
  const glyph = await sharp({ text: { text: `<span foreground="white">${text}</span>`, font: "Noto Sans 24", rgba: true } }).png().toBuffer({ resolveWithObject: true });
  const source = await sharp(pixels, { raw: { width, height, channels: 4 } }).composite([{ input: glyph.data, left: 40, top: 65 }]).png().toBuffer();
  const input = reading(text, { left: 40, top: 65, width: glyph.info.width, height: glyph.info.height }, width, height);
  const data = await raw(source), measured = measureFigure(data, width, height, input), context = prepareFigureSpace(width, height, measured, data);
  const ordinary = figureSpace(data, width, height, 0, measured, [], context), surface = figureSurfaceSpace(data, width, height, 0, measured, [], context)!;
  expect(ordinary.rectangles[0].width).toBeGreaterThan(surface.rectangles[0].width);
  const floor = Math.ceil(await figureFontSize(input.regions[0], measured[0]) * FIGURE_MIN_FONT_SCALE);
  const budgets = await Promise.all([ordinary, surface].map(async space => Math.max(1, ...await Promise.all(space.rectangles.map(b => figureCapacity(floor, b, "en"))))));
  expect(budgets[0]).toBeGreaterThan(budgets[1]);
  const out = await renderFigureLabels(source, input, ["M".repeat(1000)], "en");
  expect(out.results[0]).toMatchObject({ status: "external", reason: "does_not_fit", maxCharacters: Math.max(...budgets),
    available: { width: Math.max(ordinary.rectangles[0].width, surface.rectangles[0].width), height: Math.max(ordinary.rectangles[0].height, surface.rectangles[0].height) } });
});

it.each([false, true])("uses matching background near an ambiguous backing without covering patterned artwork (patterned: %s)", async patterned => {
  const width = 300, height = 160, text = "H".repeat(6), pixels = Buffer.alloc(width * height * 4, 255);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const onBacking = x >= 45 && x < 180 && y >= 80 && y < 104;
    const color = !patterned || onBacking ? [25, 47, 52] : y < 104 ? [19, 42, 47] : ((Math.floor(x / 7) + Math.floor(y / 7)) % 2 ? [186, 141, 93] : [115, 170, 146]);
    for (let c = 0; c < 3; c++) pixels[(y * width + x) * 4 + c] = color[c];
  }
  const glyph = await sharp({ text: { text: `<span foreground="white">${text}</span>`, font: "Noto Sans 16", rgba: true } }).png().toBuffer({ resolveWithObject: true });
  const source = await sharp(pixels, { raw: { width, height, channels: 4 } }).composite([{ input: glyph.data, left: 60, top: 85 }]).png().toBuffer();
  const out = await renderFigureLabels(source, reading(text, { left: 60, top: 85, width: glyph.info.width, height: glyph.info.height }, width, height), [`${"M".repeat(6)}\n${"M".repeat(6)}`], "en");
  expect(out.results[0].status).toBe("rendered");
  if (patterned) await unchanged(source, out.bytes!, width, { left: 0, top: 104, width, height: height - 104 });
});

it("keeps a large multiline label inside the bounded search window", () => {
  const anchor = { left: 50, top: 670, width: 1320, height: 252 };
  const window = figureSpaceWindow(anchor, 2000, 1125);
  expect(window.height).toBeGreaterThanOrEqual(anchor.height);
  expect(window.width * window.height).toBeLessThanOrEqual(FIGURE_SPACE.maxWindowPixels);
});

it.each([{ width: 1990, height: 1600 }, { width: 2200, height: 20 }])("skips background modelling for a label beyond the search window: %o", dimensions => {
  const measured = [{ box: { left: 0, top: 0, ...dimensions }, points: [0], lineCount: 1, lineHeights: [dimensions.height], uncertain: false }];
  const context = prepareFigureSpace(2400, 2000, measured);
  Object.defineProperty(context, "surfaces", { get() { throw new Error("Background model must not be requested"); } });
  expect(figureSurfaceSpace(Buffer.alloc(0), 2400, 2000, 0, measured, [], context)).toBeUndefined();
});

it("retains a thin upright glyph and wraps inside its enclosure without changing the frame or arrow", async () => {
  const width = 300, height = 180, text = `AI${"山".repeat(5)}`;
  const marks = Buffer.from(`<svg width="${width}" height="${height}"><rect width="300" height="180" fill="white"/><rect x="50" y="60" width="150" height="50" fill="none" stroke="#888"/><path d="M220 65L240 85L220 105Z" fill="#555"/></svg>`);
  const glyph = await sharp({ text: { text, font: "Noto Sans CJK JP 14", rgba: true } }).png().toBuffer({ resolveWithObject: true });
  const source = await sharp(marks).composite([{ input: glyph.data, left: 75, top: 78 }]).png().toBuffer();
  const out = await renderFigureLabels(source, reading(text, { left: 75, top: 78, width: glyph.info.width, height: glyph.info.height }, width, height, "ja"), [`${"W".repeat(8)} ${"W".repeat(8)}`], "en");
  expect(out.results[0].status).toBe("rendered");
  for (const box of [{ left: 49, top: 59, width: 153, height: 3 }, { left: 49, top: 109, width: 153, height: 3 }, { left: 49, top: 59, width: 3, height: 53 }, { left: 199, top: 59, width: 3, height: 53 }, { left: 219, top: 64, width: 23, height: 43 }]) await unchanged(source, out.bytes!, width, box);
});
