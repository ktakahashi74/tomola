import sharp, { type Sharp } from "sharp";
import { expect, it, vi } from "vitest";
import { normalizeFigureReading, type FigureReading, type FigureRegion } from "~/lib/figure";
import { renderFigure } from "./helpers/figure-render";
import { figureCapacity, figureFontSize, figureTextColor, renderFigureLabels } from "~/lib/figure-render.server";
import { figureFontDescription } from "~/lib/figure-fonts.server";
import { parseFigureReading } from "~/lib/figure-reading.server";
import { measureFigure } from "~/lib/figure-space.server";

const width = 400, height = 240;
const region: FigureRegion = { text: "HHH", lang: "en", confidence: 1, x: 0.1, y: 0.1, width: 0.25, height: 1 / 6, orientation: "horizontal" };
const reading = (regions: FigureRegion[] = [region]): FigureReading => ({ lang: "en", confidence: 1, regions });
const blank = () => sharp({ create: { width, height, channels: 4, background: "white" } });
const mark = (left: number, top: number, width: number, height: number) => ({ input: { create: { width, height, channels: 4 as const, background: "black" } }, left, top });
const bounded = () => blank().composite([mark(144, 0, 1, height)]);

it("preserves dropped label pixels beside the retained glyphs and blocks translation placement over them", async () => {
  const glyph = await sharp({ text: { text: "HHH", font: figureFontDescription("en", 28), rgba: true } }).png().toBuffer({ resolveWithObject: true });
  const left = 40, top = 90, neighbour = left + glyph.info.width + 2;
  // Small nearby glyph fragments would otherwise qualify for OCR recovery;
  // the two-pixel marker also exercises the antialias erasure fringe.
  const bytes = await blank().composite([
    { input: glyph.data, left, top }, mark(neighbour, top + 4, 2, 2),
    mark(neighbour + 4, top + 2, 8, 12), mark(neighbour + 16, top + 2, 8, 12),
  ]).png().toBuffer();
  const box = (text: string, l: number, t: number, w: number, h: number) => ({ text, lang: "en", confidence: 1, orientation: "horizontal",
    box_2d: [t / height, l / width, (t + h) / height, (l + w) / width].map(v => Math.round(v * 1000)),
  });
  const source = parseFigureReading(JSON.stringify({ lang: "en", confidence: 1, regions: [
    box("HHH", left, top, glyph.info.width, glyph.info.height),
    box("Omitted one", neighbour, top, 20, 20), box("Omitted two", neighbour + 10, top, 20, 20),
  ] }), () => {}, { discardOverlaps: true })!;
  expect(source.regions.map(r => r.text)).toEqual(["HHH"]);
  expect(source.protectedBoxes).toHaveLength(2);
  const result = await renderFigureLabels(bytes, source, ["Long translated text"], "en");
  expect(result.results).toMatchObject([{ status: "rendered", source: "HHH" }]);
  const original = await raw(bytes), rendered = await raw(result.bytes!);
  for (let y = top; y < top + 20; y++) for (let x = neighbour; x < neighbour + 30; x++) {
    const p = (y * width + x) * 4;
    expect(rendered.subarray(p, p + 4)).toEqual(original.subarray(p, p + 4));
  }
  expect(rendered.equals(original)).toBe(false);
});

it("relaxes diagram clearance before excluding a label whose source edge is outside the preferred area", async () => {
  const glyph = await sharp({ text: { text: "入力データ", font: figureFontDescription("ja", 32), rgba: true } }).png().toBuffer({ resolveWithObject: true });
  const bytes = await blank().composite([mark(34, 70, 2, 90), { input: glyph.data, left: 40, top: 90 }]).png().toBuffer();
  const source = reading([{ ...region, text: "入力データ", lang: "ja", x: 40 / width, y: 90 / height, width: glyph.info.width / width, height: glyph.info.height / height }]);
  source.lang = "ja";
  const result = await renderFigureLabels(bytes, source, ["Data"], "en");
  expect(result.results[0].status).toBe("rendered");
  const out = await raw(result.bytes!), original = await raw(bytes);
  for (let y = 70; y < 160; y++) for (let x = 34; x < 36; x++) {
    const p = (y * width + x) * 4;
    expect(out.subarray(p, p + 4)).toEqual(original.subarray(p, p + 4));
  }
});

it("moves a label within safe space at the original size before shrinking it", async () => {
  const font = figureFontDescription("en", 28), text = "Wide translated label";
  const glyph = await sharp({ text: { text: "HHH", font, rgba: true } }).png().toBuffer({ resolveWithObject: true });
  const source = reading([{ ...region, x: 40 / width, y: 90 / height, width: glyph.info.width / width, height: glyph.info.height / height }]);
  const sourceBytes = await blank().composite([{ input: glyph.data, left: 40, top: 90 }]).png().toBuffer();
  const sourceSize = await figureFontSize(source.regions[0], measureFigure(await raw(sourceBytes), width, height, source)[0]);
  const translated = await sharp({ text: { text, font: figureFontDescription("en", sourceSize), rgba: true } }).png().toBuffer({ resolveWithObject: true });
  const rule = 40 + translated.info.width - 20;
  const bytes = await blank().composite([mark(rule, 0, 2, height), { input: glyph.data, left: 40, top: 90 }]).png().toBuffer();
  const result = await renderFigureLabels(bytes, source, [text], "en");
  expect(result.results[0].status).toBe("rendered");
  const out = await raw(result.bytes!);
  const rows = inkRows(out, 0, rule);
  expect(rows).toHaveLength(1);
  const reference = await blank().composite([{ input: translated.data, left: 0, top: 90 }]).png().toBuffer();
  expect(rows[0].length).toBe(inkRows(await raw(reference))[0].length);
  const xs = Array.from({ length: rule }, (_, x) => x).filter(x => rows[0].some(y => dark(out, x, y)));
  expect(xs[0]).toBeLessThan(40);
  expect(xs.at(-1)).toBeLessThanOrEqual(rule - 3);
});

it.each(["left", "right"] as const)("keeps distant %s column edges, common sizes and clearance from equations", async align => {
  const w = 900, h = 700, edge = align === "left" ? 210 : 690;
  const texts = ["入力", "入力データ", "入力値"], tops = [80, 290, 500];
  const glyphs = await Promise.all(texts.map(text => sharp({ text: { text, font: figureFontDescription("ja", 32), rgba: true } }).png().toBuffer({ resolveWithObject: true })));
  const equation = await sharp({ text: { text: "p(w | D) = 1", font: "Noto Sans 32", rgba: true } }).png().toBuffer({ resolveWithObject: true });
  const equationLeft = align === "left" ? 500 : 190;
  const regions: FigureRegion[] = glyphs.map((glyph, i) => ({ ...region, lang: "ja", text: texts[i],
    x: (align === "left" ? edge : edge - glyph.info.width) / w, y: tops[i] / h, width: glyph.info.width / w, height: glyph.info.height / h }));
  const bytes = await sharp({ create: { width: w, height: h, channels: 4, background: "white" } }).composite([
    ...glyphs.map((glyph, i) => ({ input: glyph.data, left: Math.round(regions[i].x * w), top: tops[i] })),
    ...tops.map(top => ({ input: equation.data, left: equationLeft, top })),
  ]).png().toBuffer();
  const source: FigureReading = { lang: "ja", confidence: 1, regions: [...regions, ...tops.map(top => ({ ...region, text: "p(w | D) = 1", x: equationLeft / w, y: top / h, width: equation.info.width / w, height: equation.info.height / h }))] };
  const result = await renderFigureLabels(bytes, source, ["HHHH HHHH HHHH", "HH", "HHH"], "en");
  expect(result.results.map(r => r.status)).toEqual(["rendered", "rendered", "rendered"]);
  const data = await sharp(result.bytes!).ensureAlpha().raw().toBuffer(), original = await sharp(bytes).ensureAlpha().raw().toBuffer();
  const bounds = tops.map(top => {
    const xs: number[] = [], ys: number[] = [];
    for (let y = top - 50; y < top + 80; y++) for (let x = align === "left" ? 150 : equationLeft + equation.info.width + 1; x < (align === "left" ? equationLeft : 750); x++) {
      if (data[(y * w + x) * 4] < 128) { xs.push(x); ys.push(y); }
    }
    return { left: Math.min(...xs), right: Math.max(...xs), height: Math.max(...ys) - Math.min(...ys) + 1 };
  });
  const edges = bounds.map(b => align === "left" ? b.left : b.right);
  expect(Math.max(...edges) - Math.min(...edges)).toBeLessThanOrEqual(2);
  const sourceEdges = tops.map(top => {
    const xs: number[] = [];
    for (let y = top; y < top + 50; y++) for (let x = align === "left" ? 150 : 450; x < (align === "left" ? 490 : 750); x++) if (original[(y * w + x) * 4] < 128) xs.push(x);
    return align === "left" ? Math.min(...xs) : Math.max(...xs);
  });
  edges.forEach((value, i) => expect(Math.abs(value - sourceEdges[i])).toBeLessThanOrEqual(3));
  expect(new Set(bounds.map(b => b.height)).size).toBe(1);
  expect(bounds[0].height).toBeLessThanOrEqual(glyphs[0].info.height);
  for (const b of bounds) expect(align === "left" ? equationLeft - b.right - 1 : b.left - equationLeft - equation.info.width).toBeGreaterThanOrEqual(10);
  for (const top of tops) for (let y = top; y < top + equation.info.height; y++) {
    const start = (y * w + equationLeft) * 4, end = start + equation.info.width * 4;
    expect(data.subarray(start, end)).toEqual(original.subarray(start, end));
  }
});
async function raw(bytes: Buffer) { return sharp(bytes).ensureAlpha().raw().toBuffer(); }
const dark = (data: Buffer, x: number, y: number) => data[(y * width + x) * 4] < 128;
function inkRows(data: Buffer, left = 0, right = width) {
  const rows: number[][] = [];
  for (let y = 0; y < height; y++) {
    if (!Array.from({ length: right - left }, (_, x) => dark(data, left + x, y)).some(Boolean)) continue;
    const last = rows[rows.length - 1];
    if (last && last[last.length - 1] === y - 1) last.push(y);
    else rows.push([y]);
  }
  return rows;
}

it.each(["normal", "bold"].flatMap(weight => [24, 36, 52].flatMap(size =>
  (["zh-Hans", "ko", "en"] as const).map(lang => ({ weight: weight as "normal" | "bold", size, lang })),
)))("matches source glyph height at $size px, $weight, $lang", async ({ weight, size, lang }) => {
  const sourceText = "Fisher情報行列", label = lang === "ko" ? "피셔 정보 행렬" : lang === "en" ? "MATRIX" : "信息矩阵";
  const glyph = await sharp({ text: { text: sourceText, font: figureFontDescription("ja", size, weight), rgba: true } }).png().toBuffer({ resolveWithObject: true });
  const bytes = await blank().composite([{ input: glyph.data, left: 40, top: 80 }]).png().toBuffer();
  const source = { ...region, text: sourceText, lang: "ja" as const, weight, y: 80 / height, width: glyph.info.width / width, height: glyph.info.height / height };
  const result = await renderFigureLabels(bytes, { lang: "ja", confidence: 1, regions: [source] }, [label], lang);
  expect(result.results[0].status).toBe("rendered");
  const sourceHeight = inkRows(await raw(bytes))[0].length;
  const targetHeight = inkRows(await raw(result.bytes!))[0].length;
  const reference = await sharp({ text: { text: label, font: figureFontDescription(lang, size, weight), rgba: true } }).png().toBuffer();
  const referenceCanvas = await blank().composite([{ input: reference, left: 40, top: 80 }]).png().toBuffer();
  // Latin capitals are shorter at the same font size; compare their own face.
  const expectedHeight = lang === "en" ? inkRows(await raw(referenceCanvas))[0].length : sourceHeight;
  expect(targetHeight / expectedHeight).toBeGreaterThanOrEqual(.92);
  expect(targetHeight / expectedHeight).toBeLessThanOrEqual(1.08);
  expect(targetHeight).toBeLessThanOrEqual(inkRows(await raw(referenceCanvas))[0].length + 1);
});

it("excludes a tight column member instead of lowering another member below its font floor", async () => {
  const w = 800, h = 400, sizes = [32, 36], tops = [100, 280];
  const glyphs = await Promise.all(sizes.map(size => sharp({ text: { text: "HHH", font: `Noto Sans ${size}`, rgba: true } }).png().toBuffer({ resolveWithObject: true })));
  const labels = glyphs.map((glyph, i) => ({ ...region, x: 40 / w, y: tops[i] / h, width: glyph.info.width / w, height: glyph.info.height / h }));
  const bytes = await sharp({ create: { width: w, height: h, channels: 4, background: "white" } }).composite([
    ...glyphs.map((glyph, i) => ({ input: glyph.data, left: 40, top: tops[i] })),
    mark(20, 86, 2, 56), mark(120, 86, 2, 56), mark(20, 86, 102, 2), mark(20, 140, 102, 2),
  ]).png().toBuffer();
  const result = await renderFigureLabels(bytes, reading(labels), ["MMMM", "II"], "en");
  expect(result.results.map(r => r.status)).toEqual(["rendered", "rendered"]);
  const data = await sharp(result.bytes!).ensureAlpha().raw().toBuffer();
  const heights = tops.map((top, i) => {
    const rows: number[] = [];
    for (let y = top - 10; y < top + 35; y++) for (let x = 24; x < (i === 0 ? 118 : 130); x++) if (data[(y * w + x) * 4] < 128) { rows.push(y); break; }
    return Math.max(...rows) - Math.min(...rows) + 1;
  });
  expect(heights[1]).toBeGreaterThan(heights[0]);
  for (const [i, text] of ["MMMM", "II"].entries()) {
    const referenceHeight = async (size: number) => {
      const ref = await sharp({ text: { text, font: `Noto Sans ${size}`, rgba: true } }).raw().toBuffer({ resolveWithObject: true });
      return Array.from({ length: ref.info.height }, (_, y) => Array.from({ length: ref.info.width }, (_, x) => ref.data[(y * ref.info.width + x) * 4 + 3] >= 128).some(Boolean)).filter(Boolean).length;
    };
    expect(heights[i]).toBeGreaterThanOrEqual(await referenceHeight(Math.ceil(sizes[i] * .75)));
    expect(heights[i]).toBeLessThanOrEqual(await referenceHeight(sizes[i]));
  }
});

it.each([40, 150, 260])("places visible glyphs independently of transparent margins at x=%i", async left => {
  const glyph = await sharp({ text: { text: "HHH", font: "Noto Sans 32", rgba: true } }).png().toBuffer({ resolveWithObject: true });
  const bytes = await blank().composite([{ input: glyph.data, left, top: 80 }]).png().toBuffer();
  const source = { ...region, x: left / width, y: 80 / height, width: glyph.info.width / width, height: glyph.info.height / height };
  const plain = await renderFigureLabels(bytes, reading([source]), ["II"], "en");
  const padded = await renderFigureLabels(bytes, reading([source]), ["\n  II  \n"], "en");
  expect(plain.results[0].status).toBe("rendered");
  expect(padded.results[0].status).toBe("rendered");
  expect(padded.bytes).toEqual(plain.bytes);
});

it("draws bold with more ink and treats stored labels without weight as normal", async () => {
  const bytes = await blank().webp({ lossless: true }).toBuffer();
  const normal = await renderFigure(bytes, reading([{ ...region, weight: "normal" }]), ["HH"], "en");
  const legacy = await renderFigure(bytes, reading(), ["HH"], "en");
  const bold = await renderFigure(bytes, reading([{ ...region, weight: "bold" }]), ["HH"], "en");
  expect(normal).not.toBeNull(); expect(bold).not.toBeNull(); expect(legacy).toEqual(normal);
  const count = (data: Buffer) => Array.from({ length: width * height }, (_, pixel) => data[pixel * 4] < 128).filter(Boolean).length;
  expect(count(await raw(bold!))).toBeGreaterThan(count(await raw(normal!)) * 1.15);
});

it.each([
  ["en", "Noto Sans", "Posterior"], ["ja", "Noto Sans CJK JP", "事後分布"], ["th", "Noto Sans Thai", "ข้อมูล"],
] as const)("draws %s bold pixels exactly as the installed bold face", async (lang, family, label) => {
  const bytes = await blank().png().toBuffer();
  const source = { ...region, text: "H".repeat(11), width: .5, height: 1 / 3, weight: "bold" as const };
  const output = await renderFigure(bytes, reading([source]), [label], lang);
  expect(output).not.toBeNull();
  // A wide, tall empty box leaves every target at the source width cap.
  const metrics = await sharp({ text: { text: source.text, font: "Noto Sans Bold 16", rgba: true } }).metadata();
  const size = Math.floor(196 * 16 / metrics.width!);
  const glyph = await sharp({ text: { text: `<span foreground="#111111" lang="${lang}">${label}</span>`, font: `${family} Bold ${size}`, rgba: true } }).png().toBuffer({ resolveWithObject: true });
  const expected = await sharp({ create: { width: glyph.info.width, height: glyph.info.height, channels: 4, background: "white" } }).composite([{ input: glyph.data, left: 0, top: 0 }]).png().toBuffer();
  const crop = async (image: Buffer) => sharp(image).flatten({ background: "white" }).trim({ background: "white", threshold: 0 }).raw().toBuffer({ resolveWithObject: true });
  const actual = await crop(output!), reference = await crop(expected);
  expect(actual.info.width).toBe(reference.info.width);
  expect(actual.info.height).toBe(reference.info.height);
  expect(actual.data).toEqual(reference.data);
});

it("measures bold capacity and source width using the bold face", async () => {
  const sample = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ", size = 32;
  const normal = await sharp({ text: { text: sample, font: `Noto Sans ${size}`, rgba: true } }).metadata();
  const bold = await sharp({ text: { text: sample, font: `Noto Sans Bold ${size}`, rgba: true } }).metadata();
  expect(bold.width).toBeGreaterThan(normal.width!);
  const box = { left: 0, top: 0, width: bold.width! + 4, height: Math.max(normal.height!, bold.height!) + 4 };
  expect(await figureCapacity(size, box, "en", true)).toBe(sample.length);
  expect(await figureCapacity(size, box, "en")).toBeGreaterThan(sample.length);
  const ink = { box: { left: 0, top: 0, width: 2000, height: 2000 }, points: [], uncertain: false, lineCount: 1, lineHeights: [] };
  const regularSize = await figureFontSize({ ...region, text: sample, weight: "normal" }, ink);
  const boldSize = await figureFontSize({ ...region, text: sample, weight: "bold" }, ink);
  expect(boldSize).toBeLessThan(regularSize);
});

it("wraps long translations into blank space while retaining readable letter height", async () => {
  const output = await renderFigure(await bounded().webp().toBuffer(), reading(), ["HHH HHH HHH"], "en");
  expect(output).not.toBeNull();
  const rows = inkRows(await raw(output!), 40, 140);
  expect(rows).toHaveLength(3);
  // The source box estimates 36 px; the 75% floor is 27 px, with capitals
  // occupying at least 19 raster rows in the bundled Regular face.
  expect(rows.every(line => line.length >= 19)).toBe(true);
  expect(rows[2][0]).toBeGreaterThan(64);
});

it("keeps the source when even three lines cannot fit above the font-size floor", async () => {
  expect(await renderFigure(await blank().webp().toBuffer(), reading(), ["HHHH ".repeat(100)], "en")).toBeNull();
});

it.each(["W".repeat(2000), "Long word ".repeat(200)])("rejects oversized text before allocating a large raster (%#)", async label => {
  const glyph = await sharp({ text: { text: "HHH", font: "Noto Sans 60", rgba: true } }).png().toBuffer({ resolveWithObject: true });
  const bytes = await blank().composite([{ input: glyph.data, left: 40, top: 80 }]).png().toBuffer();
  const source = { ...region, y: 80 / height, width: glyph.info.width / width, height: glyph.info.height / height };
  const raster = vi.spyOn(sharp.prototype, "raw");
  try {
    const result = await renderFigureLabels(bytes, reading([source]), [label], "en");
    expect(result.bytes).toBeNull();
    expect(result.results[0]).toMatchObject({ status: "external", reason: "does_not_fit" });
    // Source decoding and 16 px reference chunks are small. Neither unwrapped
    // nor wrapped failed attempts may allocate a multi-megapixel text raster.
    const rasters = await Promise.all(raster.mock.contexts.map(image => (image as Sharp).metadata()));
    expect(rasters.length).toBeGreaterThan(0);
    expect(Math.max(...rasters.map(info => info.width! * info.height!))).toBeLessThanOrEqual(width * height);
  } finally { raster.mockRestore(); }
});

it("wraps within an existing multiline source box", async () => {
  const multiline = { ...region, text: "HHH\nHHH", height: 1 / 3 };
  const output = await renderFigure(await bounded().webp().toBuffer(), reading([multiline]), ["HHH HHH"], "en");
  expect(output).not.toBeNull();
  const rows = inkRows(await raw(output!), 40, 140);
  expect(rows).toHaveLength(2);
  expect(rows.every(line => line.length >= 24)).toBe(true);
  expect(rows[1].at(-1)).toBeLessThan(104);
});

it("uses blank space above a lower label without crossing an earlier foreign label", async () => {
  const lower = { ...region, y: 0.7 };
  const bytes = await bounded().webp().toBuffer();
  expect(await renderFigure(bytes, reading([lower]), ["HHH HHH HHH"], "en")).not.toBeNull();
  const earlier = { ...region, lang: "ja" as const, y: 0.5, height: 0.19 };
  expect(await renderFigure(bytes, reading([lower, earlier]), ["HHH HHH HHH"], "en")).toBeNull();
});

it.each(["diagram", "foreign label"])("uses two-dimensional space without touching a %s", async obstacle => {
  const line = { input: { create: { width: 100, height: 2, channels: 4 as const, background: "black" } }, left: 40, top: 112 };
  const bytes = await blank().composite([line, mark(142, 0, 1, height)]).webp({ lossless: true }).toBuffer();
  const regions = obstacle === "diagram" ? [region] : [region, { ...region, lang: "ja" as const, y: 112 / height, height: 0.1 }];
  const output = await renderFigure(bytes, reading(regions), ["HHH HHH HHH"], "en");
  expect(output).not.toBeNull();
  const data = await raw(output!), source = await raw(bytes);
  for (let y = 110; y < 116; y++) for (let x = 38; x < 141; x++) {
    const offset = (y * width + x) * 4;
    expect(data.subarray(offset, offset + 4)).toEqual(source.subarray(offset, offset + 4));
  }
});

it("refits and erases actual glyph fringes while preserving neighbouring labels and lines", async () => {
  const glyph = await sharp({ text: { text: "HHH", font: "Noto Sans 32", rgba: true } }).png().toBuffer();
  const bytes = await blank().composite([{ input: glyph, left: 40, top: 22 }, mark(141, 24, 5, 40), mark(25, 20, 1, 50)]).webp({ lossless: true }).toBuffer();
  const neighbour: FigureRegion = { ...region, lang: "ja", x: 141 / width, width: 5 / width };
  const output = await renderFigure(bytes, reading([region, neighbour]), ["I"], "en");
  expect(output).not.toBeNull();
  const source = await raw(bytes), rendered = await raw(output!);
  expect(dark(rendered, 40, 22)).toBe(false);
  for (let y = 0; y < height; y++) for (const x of [25, 141, 142, 145]) {
    const offset = (y * width + x) * 4;
    expect(rendered.subarray(offset, offset + 4)).toEqual(source.subarray(offset, offset + 4));
  }
});

it("widens a left-aligned title to the right before wrapping or shrinking below the floor", async () => {
  const output = await renderFigure(await blank().webp().toBuffer(), reading(), ["HHH HHH HHH"], "en");
  expect(output).not.toBeNull();
  const data = await raw(output!), rows = inkRows(data);
  expect(rows).toHaveLength(1);
  expect(rows[0].length).toBeGreaterThanOrEqual(24);
  const columns = Array.from({ length: width }, (_, x) => x).filter(x => rows[0].some(y => dark(data, x, y)));
  expect(columns[0]).toBeGreaterThanOrEqual(42);
  expect(columns[0]).toBeLessThanOrEqual(43);
  expect(columns.at(-1)).toBeGreaterThan(240);
});

it.each(["left", "centre", "right"] as const)("retains %s alignment on wrapped lines", async align => {
  const left = align === "left" ? 40 : align === "right" ? 260 : 150;
  const label = { ...region, x: left / width };
  const bytes = await blank().composite([mark(left - 15, 0, 1, height), mark(left + 115, 0, 1, height)]).webp({ lossless: true }).toBuffer();
  const output = await renderFigure(bytes, reading([label]), ["HHH HHH H"], "en");
  expect(output).not.toBeNull();
  const data = await raw(output!), rows = inkRows(data, left, left + 100);
  expect(rows).toHaveLength(3);
  const edges = rows.map(line => {
    const xs = Array.from({ length: 100 }, (_, i) => left + i).filter(x => line.some(y => dark(data, x, y)));
    return align === "left" ? xs[0] : align === "right" ? xs.at(-1)! : (xs[0] + xs.at(-1)!) / 2;
  });
  expect(Math.max(...edges) - Math.min(...edges)).toBeLessThanOrEqual(1);
});

it.each(["centre", "right"] as const)("widens a %s-aligned label without moving its anchor", async align => {
  const label = { ...region, x: align === "right" ? 0.65 : 0.375 };
  const output = await renderFigure(await blank().webp().toBuffer(), reading([label]), ["HHH HHH HHH"], "en");
  expect(output).not.toBeNull();
  const data = await raw(output!), rows = inkRows(data);
  expect(rows).toHaveLength(1);
  const xs = Array.from({ length: width }, (_, x) => x).filter(x => rows[0].some(y => dark(data, x, y)));
  if (align === "right") expect(Math.abs(xs.at(-1)! - 357)).toBeLessThanOrEqual(1);
  else expect(Math.abs((xs[0] + xs.at(-1)!) / 2 - 199.5)).toBeLessThanOrEqual(1);
});

it.each(["left", "right"] as const)("uses the unneeded gap without touching a foreign label on the %s", async side => {
  const label = side === "right" ? region : { ...region, x: 0.65 };
  const neighbour = { ...region, lang: "ja" as const, x: side === "right" ? 0.7 : 0.2, width: 0.1 };
  const bytes = await blank().composite([mark(side === "right" ? 280 : 80, 24, 40, 40)]).webp({ lossless: true }).toBuffer();
  const output = await renderFigure(bytes, reading([label, neighbour]), ["HHH HHH HHH"], "en");
  expect(output).not.toBeNull();
  const data = await raw(output!), source = await raw(bytes);
  for (let y = 0; y < height; y++) for (let x = side === "right" ? 278 : 0; x < (side === "right" ? width : 122); x++) {
    const offset = (y * width + x) * 4;
    expect(data.subarray(offset, offset + 4)).toEqual(source.subarray(offset, offset + 4));
  }
});

it.each(["left", "right"] as const)("stops horizontal expansion before a diagram mark on the %s", async side => {
  const label = side === "right" ? region : { ...region, x: 0.65 };
  const x = 200;
  const bytes = await blank().composite([mark(x, 10, 2, 90)]).webp({ lossless: true }).toBuffer();
  const output = await renderFigure(bytes, reading([label]), ["HHH HHH HHH"], "en");
  expect(output).not.toBeNull();
  const data = await raw(output!), source = await raw(bytes);
  expect(inkRows(data, side === "right" ? 40 : 205, side === "right" ? 198 : 360).length).toBeGreaterThan(1);
  for (let y = 0; y < height; y++) for (let col = 198; col <= 204; col++) {
    const offset = (y * width + col) * 4;
    expect(data.subarray(offset, offset + 4)).toEqual(source.subarray(offset, offset + 4));
  }
});

it("rejects changed mathematical symbols before drawing", async () => {
  expect(await renderFigure(await blank().webp().toBuffer(), reading([{ ...region, text: "∂wK(w) = 0" }]), ["dw K(w) = 0"], "en")).toBeNull();
});

it.each([false, true].flatMap(split => [40, 150, 280].map(left => ({ split, left }))))("uses one capped font size for two source lines, split: $split, left: $left", async ({ split, left }) => {
  const glyph = await sharp({ text: { text: "HHH", font: "Noto Sans 32", rgba: true } }).png().toBuffer({ resolveWithObject: true });
  const bytes = await blank().composite([{ input: glyph.data, left, top: 30 }, { input: glyph.data, left, top: 67 }, mark(left - (left === 280 ? 35 : 15), 0, 1, height), mark(left + 105, 0, 1, height)]).png().toBuffer();
  const first = { ...region, x: left / width, y: 30 / height, width: glyph.info.width / width, height: glyph.info.height / height };
  const regions = split ? [first, { ...first, y: 67 / height }] : [{ ...first, text: "HHH\nHHH", height: (37 + glyph.info.height) / height }];
  const result = await renderFigureLabels(bytes, reading(regions), split ? ["HH", "HHHHH"] : ["HH\nHHHHH"], "en");
  expect(result.results.every(r => r.status === "rendered")).toBe(true);
  const rows = inkRows(await raw(result.bytes!), left - (left === 280 ? 33 : 2), left + 104);
  expect(rows).toHaveLength(2);
  expect(rows[0].length).toBe(rows[1].length);
  expect(rows[0].length).toBeLessThanOrEqual(glyph.info.height);
});

it("caps a mixed-height multiline source using its tallest source glyphs", async () => {
  const glyph = await sharp({ text: { text: "HHH\n...", font: "Noto Sans 32", rgba: true } }).png().toBuffer({ resolveWithObject: true });
  const bytes = await blank().composite([{ input: glyph.data, left: 40, top: 30 }]).png().toBuffer();
  const multiline = { ...region, text: "HHH\n...", x: .1, y: 30 / height, width: glyph.info.width / width, height: glyph.info.height / height };
  const result = await renderFigureLabels(bytes, reading([multiline]), ["HH\nHH"], "en");
  expect(result.results[0].status).toBe("rendered");
  const sourceRows = inkRows(await raw(bytes)), rows = inkRows(await raw(result.bytes!));
  expect(rows).toHaveLength(2);
  expect(rows[0].length).toBe(rows[1].length);
  expect(rows[0].length).toBeLessThanOrEqual(sourceRows[0].length);
});

it("refits overlapping grouped translations around previously placed text with a two-pixel gap", async () => {
  const glyph = async (color: string) => sharp({ text: { text: `<span foreground="${color}">HHH</span>`, font: "Noto Sans 32", rgba: true } }).png().toBuffer({ resolveWithObject: true });
  const first = await glyph("#d01010"), second = await glyph("#1020d0");
  const bytes = await blank().composite([{ input: first.data, left: 40, top: 60 }, { input: second.data, left: 40, top: 100 }]).png().toBuffer();
  const label = { ...region, x: 40 / width, y: 60 / height, width: first.info.width / width, height: first.info.height / height };
  const result = await renderFigureLabels(bytes, reading([label, { ...label, y: 100 / height }]), ["Long word Long word Long word", "Another line Another line Another line"], "en");
  expect(result.results.map(r => r.status)).toEqual(["rendered", "rendered"]);
  const data = await raw(result.bytes!);
  const bounds = [0, 2].map(channel => {
    const points: { x: number; y: number }[] = [];
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      if (data[p + channel] - data[p + 1] > 80 && data[p + channel] - data[p + 2 - channel] > 80) points.push({ x, y });
    }
    expect(points.length).toBeGreaterThan(100);
    return { left: Math.min(...points.map(p => p.x)), right: Math.max(...points.map(p => p.x)) + 1, top: Math.min(...points.map(p => p.y)), bottom: Math.max(...points.map(p => p.y)) + 1 };
  });
  const [a, b] = bounds;
  expect(a.right + 2 <= b.left || b.right + 2 <= a.left || a.bottom + 2 <= b.top || b.bottom + 2 <= a.top).toBe(true);
});

it("preserves the source red glyph interiors rather than painting black", async () => {
  const glyph = await sharp({ text: { text: '<span foreground="#e02030">HHH</span>', font: "Noto Sans 32", rgba: true } }).png().toBuffer();
  const bytes = await blank().composite([{ input: glyph, left: 40, top: 30 }]).png().toBuffer();
  const result = await renderFigureLabels(bytes, reading(), ["II"], "en");
  expect(result.results[0].status).toBe("rendered");
  const pixels = await raw(result.bytes!);
  const colors: number[][] = [];
  for (let p = 0; p < width * height; p++) if (pixels[p * 4 + 1] < 128) colors.push([...pixels.subarray(p * 4, p * 4 + 3)]);
  expect(colors.length).toBeGreaterThan(20);
  expect(colors.every(([r, g, b]) => r > 200 && r - g > 100 && r - b > 90)).toBe(true);
  expect(colors.some(([r, g, b]) => r === 224 && g === 32 && b === 48)).toBe(true);
});

it.each([[255, 255, 255, 255], [0, 0, 0, 255]].map(bg => ({ bg })))("uses black or white when sampled ink has insufficient luminance contrast on $bg", async ({ bg }) => {
  const rgb = bg[0] ? [255, 255, 0, 255] : [0, 0, 25, 255];
  expect(figureTextColor(Buffer.from(rgb), bg, { box: { left: 0, top: 0, width: 1, height: 1 }, points: [0], lineCount: 1, lineHeights: [1], uncertain: false })).toBe(bg[0] ? "#111111" : "#ffffff");
});

it.each(["HHH", " hhh "])("records an unchanged label without repainting it: %s", async text => {
  const result = await renderFigureLabels(await blank().png().toBuffer(), reading(), [text], "en");
  expect(result).toEqual({ bytes: null, results: [{ source: "HHH", translation: text, status: "unchanged", reason: null }] });
});

it("compares normalized cached labels and never paints a translated TeX command", async () => {
  const bytes = await blank().png().toBuffer();
  const cached = normalizeFigureReading(reading([{ ...region, text: "Water level \\epsilon" }]));
  const unchanged = await renderFigureLabels(bytes, cached, ["Water level ε"], "en");
  expect(unchanged).toMatchObject({ bytes: null, results: [{ source: "Water level ε", status: "unchanged", reason: null }] });
  const rejected = await renderFigureLabels(bytes, cached, ["Level \\epsilon"], "en");
  expect(rejected).toMatchObject({ bytes: null, results: [{ status: "external", reason: "math_mismatch" }] });
  const accepted = await renderFigureLabels(bytes, cached, ["Level ε"], "en");
  expect(accepted.results[0].status).toBe("rendered");
});
