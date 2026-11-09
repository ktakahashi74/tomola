// Offline product-geometry diagnostics. No database, environment file or API.
// Run with node --import tsx scripts/figure-space-diagnostics.mjs --input DIR --output DIR --before DIR
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { join, basename } from "node:path";
import sharp from "sharp";
import { FIGURE_SPACE, background, figureBox, figureEraseMask, figureSpace, measureFigure, prepareFigureSpace, restoreFigureBackground } from "../app/lib/figure-space.server.ts";
import { figureCapacity, figureFontSize } from "../app/lib/figure-render.server.ts";
const xml = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);
const hash = value => createHash("sha256").update(value).digest("hex");
function svgBox(b, color, dash = "", stroke = 2) {
  return b ? `<rect x="${b.left}" y="${b.top}" width="${b.width}" height="${b.height}" fill="none" stroke="${color}" stroke-width="${stroke}" ${dash ? `stroke-dasharray="${dash}"` : ""}/>` : "";
}
function geometrySvg(rows, width, height) {
  return Buffer.from(`<svg width="${width}" height="${height}">${rows.map(r =>
    (r.translated ? `<rect x="${r.erase.left}" y="${r.erase.top}" width="${r.erase.width}" height="${r.erase.height}" fill="#ff9100" fill-opacity=".16"/>` +
    svgBox(r.free, "#1769ff", "8 5") + svgBox(r.wide, "#1769ff") + svgBox(r.expanded, "#16a34a", "5 3") + svgBox(r.reference.rectangle, "#00a9c7", "", 3) +
    "" : "") + svgBox(r.box, "#f22238", "", 2) + svgBox(r.ink.box, "#ad28cf", "4 2", 2) +
    `<text x="${r.box.left}" y="${Math.max(16, r.box.top - 5)}" font-size="18" font-family="sans-serif" fill="#d61932" stroke="white" stroke-width="3" paint-order="stroke">${r.id}</text>`).join("")}</svg>`);
}
async function writeOverview(data, width, height, rows, cyan, target) {
  const layer = Buffer.alloc(width * height * 4);
  for (let p = 0; p < cyan.length; p++) if (cyan[p]) { layer[p * 4] = 0; layer[p * 4 + 1] = 196; layer[p * 4 + 2] = 225; layer[p * 4 + 3] = 25; }
  const composed = await sharp(data, { raw: { width, height, channels: 4 } }).composite([
    { input: layer, raw: { width, height, channels: 4 } }, { input: geometrySvg(rows, width, height) },
  ]).png().toBuffer();
  const over = await sharp(composed).resize({ width: 1600 }).png().toBuffer();
  const legend = Buffer.from('<svg width="1600" height="65"><rect width="1600" height="65" fill="white"/><g font-family="sans-serif" font-size="19"><text x="18" y="24" fill="#d61932">Red: AI box + label ID</text><text x="320" y="24" fill="#ad28cf">Purple: measured ink</text><text x="660" y="24" fill="#d07800">Orange fill: erase</text><text x="18" y="52" fill="#1769ff">Blue: candidate at original height</text><text x="570" y="52" fill="#16a34a">Green: largest safe rectangle</text><text x="850" y="52" fill="#008ca5">Cyan: product space + largest rectangle</text></g></svg>');
  const out = await sharp(over).extend({ bottom: 65, background: "white" }).composite([{ input: legend, left: 0, top: Math.round(height * 1600 / width) }]).png().toBuffer();
  await writeFile(target, out);
}

async function writeCrop(data, width, height, row, target) {
  const b = row.box, margin = 65;
  const crop = { left: Math.max(0, b.left - margin), top: Math.max(0, b.top - margin),
    width: Math.min(width, b.left + b.width + margin) - Math.max(0, b.left - margin),
    height: Math.min(height, b.top + b.height + margin) - Math.max(0, b.top - margin) };
  const original = await sharp(data, { raw: { width, height, channels: 4 } }).extract(crop).png().toBuffer();
  const overlay = await sharp(data, { raw: { width, height, channels: 4 } }).composite([{ input: geometrySvg([row], width, height) }]).png().toBuffer();
  const annotated = await sharp(overlay).extract(crop).png().toBuffer();
  const erased = row.erased ?? data;
  const erasedCrop = await sharp(erased, { raw: { width, height, channels: 4 } }).extract(crop).png().toBuffer();
  const titleHeight = 30, panelWidth = Math.min(1000, crop.width), panelHeight = Math.round(crop.height * panelWidth / crop.width);
  const panels = await Promise.all([original, annotated, erasedCrop].map(input => sharp(input).resize({ width: panelWidth }).png().toBuffer()));
  const header = Buffer.from(`<svg width="${panelWidth * 3}" height="30"><rect width="100%" height="100%" fill="white"/><g font-family="sans-serif" font-size="16">${["Original", `Geometry #${row.id}`, "Measured glyph erase (no translation)"].map((s, i) => `<text x="${i * panelWidth + 8}" y="21">${s}</text>`).join("")}</g></svg>`);
  await sharp({ create: { width: panelWidth * 3, height: panelHeight + titleHeight, channels: 4, background: "white" } }).composite([
    { input: header, left: 0, top: 0 }, ...panels.map((input, i) => ({ input, left: i * panelWidth, top: titleHeight })),
  ]).png().toFile(target);
  return crop;
}


async function diagnose(inputDir, outputDir, beforeDir, name) {
  const readingBytes = await readFile(join(inputDir, name));
  const saved = JSON.parse(readingBytes), id = basename(name, ".reading.json");
  const bytes = await readFile(join(inputDir, `${id}.webp`));
  const { data, info: { width, height } } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(width, saved.width); assert.equal(height, saved.height);
  const before = beforeDir ? JSON.parse(await readFile(join(beforeDir, `${id}.json`))) : null;
  const reading = saved.reading, measured = measureFigure(data, width, height, reading);
  const context = prepareFigureSpace(width, height, measured);
  const rows = [], cyan = new Uint8Array(width * height);
  for (const [i, region] of reading.regions.entries()) {
    const ink = measured[i], translated = region.lang === reading.lang, box = figureBox(region, width, height);
    const space = translated ? figureSpace(data, width, height, i, measured, [], context) : null;
    const rectangle = space?.rectangles[0] ?? null;
    const fullMask = new Uint8Array(width * height);
    if (space) for (let y = 0; y < space.window.height; y++) fullMask.set(space.mask.subarray(y * space.window.width, (y + 1) * space.window.width), (space.window.top + y) * width + space.window.left);
    const originalSize = await figureFontSize(region, ink), minimumSize = Math.max(1, Math.ceil(originalSize * .75));
    const old = before?.rows[i], sameFloor = old?.minimumSize ?? minimumSize;
    const capacity = translated ? await figureCapacity(sameFloor, rectangle ?? { width: 0, height: 0 }, "en", region.weight === "bold") : 0;
    const erase = space?.erase ?? ink.box;
    const erased = translated ? restoreFigureBackground(data, width, height, erase) : data;
    const mask = translated ? figureEraseMask(width, height, i, measured) : new Uint8Array(width * height);
    for (let p = 0; p < mask.length; p++) if (!mask[p]) for (let c = 0; c < 4; c++) erased[p * 4 + c] = data[p * 4 + c];
    let residual = 0;
    for (const p of ink.points) if (!mask[p]) residual++;
    const row = { id: i + 1, text: region.text, lang: region.lang, translated, box,
      ink: { ...ink, points: undefined, protectedPoints: undefined, protectedPixels: ink.protectedPoints?.length ?? 0 }, inkPixels: ink.points.length, residualPixels: residual,
      erase, color: background(data, width, height, ink.box), free: rectangle,
      wide: rectangle ? { ...rectangle, top: ink.box.top, height: ink.box.height } : null,
      expanded: rectangle, reference: { rectangle, candidateCount: space?.rectangles.length ?? 0 },
      originalSize, minimumSize,
      before: old ? { expanded: old.expanded, originalSize: old.originalSize, minimumSize: old.minimumSize, capacity: old.capacity.current, residualPixels: old.residualPixels } : null,
      capacity: { current: capacity, before: old?.capacity.current ?? null, sameMinimumSize: sameFloor,
        afterAtNewMinimum: translated && rectangle ? await figureCapacity(minimumSize, rectangle, "en", region.weight === "bold") : 0 },
    };
    if (translated) {
      await sharp(fullMask, { raw: { width, height, channels: 1 } }).linear(255).png().toFile(join(outputDir, `${id}-label-${String(i + 1).padStart(2, "0")}-space.png`));
      if (rectangle) for (let y = rectangle.top; y < rectangle.top + rectangle.height; y++) for (let x = rectangle.left; x < rectangle.left + rectangle.width; x++) assert.equal(fullMask[y * width + x], 1);
      for (let p = 0; p < cyan.length; p++) if (fullMask[p]) cyan[p] = 1;
      await writeCrop(data, width, height, { ...row, erased }, join(outputDir, `${id}-label-${String(i + 1).padStart(2, "0")}.png`));
    }
    rows.push(row);
    process.stdout.write(`${id} #${i + 1}/${reading.regions.length} ${translated ? `${old?.expanded.width ?? 0}x${old?.expanded.height ?? 0} -> ${rectangle?.width ?? 0}x${rectangle?.height ?? 0}` : "protected"}\n`);
  }
  await writeOverview(data, width, height, rows, cyan, join(outputDir, `${id}.png`));
  const sourceHash = hash(Buffer.concat(await Promise.all(["figure-render.server.ts", "figure-space.server.ts"].map(n => readFile(new URL(`../app/lib/${n}`, import.meta.url))))));
  const result = { id, width, height, imageHash: hash(bytes), readingHash: hash(readingBytes), sourceHash, options: FIGURE_SPACE,
    assumptions: ["No saved translations are available. Labels are probed independently, without previously placed translations.",
      "Capacity compares the old and new geometry at the old minimum font size; afterAtNewMinimum also includes font-size correction.",
      "Geometry and capacity do not establish translation success or semantic layout correctness."], rows };
  await writeFile(join(outputDir, `${id}.json`), JSON.stringify(result, null, 2) + "\n");
  return result;
}
const args = process.argv.slice(2);
const value = flag => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const input = value("--input"), output = value("--output"), before = value("--before");
if (!input || !output) throw new Error("Usage: --input DIR --output DIR [--before DIR]");
await mkdir(output, { recursive: true });
const results = [];
for (const name of (await readdir(input)).filter(n => n.endsWith(".reading.json")).sort()) results.push(await diagnose(input, output, before, name));
await writeFile(join(output, "index.json"), JSON.stringify({ options: FIGURE_SPACE, figures: results.map(r => ({ id: r.id, sourceHash: r.sourceHash, labels: r.rows.length, translated: r.rows.filter(row => row.translated).length })) }, null, 2) + "\n");
