import { FIGURE_SPACE, background, figureEraseMask, figureSpaceWindow, inside, surfaceColor, type FigureBackground, type FigureBox, type FigureInk } from "./figure-space.server";

export const FIGURE_OVERLAP = { maxRatio: .1, maxErasureDeviationRatio: .1, treatment: "halo" as "halo" | "backing" };

const intersects = (a: FigureBox, b: FigureBox) => a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;

// Sampling artwork beneath source text can leave bright streaks. When too many
// restored pixels differ, use the smooth field within the same erasure mask.
export function figureOverlapBackground(patch: Buffer, box: FigureBox, mask: Uint8Array, surface?: FigureBackground, obstacles: FigureBox[] = []): Buffer {
  if (!surface) return patch;
  let pixels = 0, different = 0;
  const allowed = (p: number) => mask[p] && !obstacles.some(b => inside(b, box.left + p % box.width, box.top + Math.floor(p / box.width)));
  for (let p = 0; p < mask.length; p++) {
    if (!allowed(p)) continue;
    pixels++;
    const q = p * 4, expected = surfaceColor(surface, box.left + p % box.width, box.top + Math.floor(p / box.width));
    let delta = Math.abs(patch[q + 3] - expected[3]);
    if (patch[q + 3] > 16 || expected[3] > 16) for (let c = 0; c < 3; c++) delta = Math.max(delta, Math.abs(patch[q + c] - expected[c]));
    if (delta > FIGURE_SPACE.backgroundNoise) different++;
  }
  if (different <= pixels * FIGURE_OVERLAP.maxErasureDeviationRatio) return patch;
  const out = Buffer.from(patch);
  for (let p = 0; p < mask.length; p++) if (allowed(p)) out.set(surfaceColor(surface, box.left + p % box.width, box.top + Math.floor(p / box.width)), p * 4);
  return out;
}

// Integral counts keep every placement query constant-time. Only failed labels
// allocate a bounded local window; no full-image mask is retained per label.
export function prepareFigureOverlap(data: Buffer, width: number, height: number, index: number, measured: FigureInk[], forbidden: FigureBox[], surface?: FigureBackground, bounds?: FigureBox) {
  const anchor = measured[index].box, window = figureSpaceWindow(anchor, width, height);
  const stride = window.width + 1;
  const color = background(data, width, height, anchor);
  // Keep the existing erasure protection for dark rules on light fields.
  // Bright glyphs on dark fields can meet artwork without clearing its fringe.
  const eraseGuard = color[0] * .299 + color[1] * .587 + color[2] * .114 > 128 ? 2 : 0;
  // Measure after source-text erasure, including its shadow and antialias
  // fringe. Protected artwork remains in the obstacle count.
  const removable = figureEraseMask(width, height, index, measured, window, bounds, eraseGuard);
  if (measured[index].points.some(p => !removable[(Math.floor(p / width) - window.top) * window.width + p % width - window.left])) return null;
  const elements = new Uint32Array(stride * (window.height + 1));
  const obstacles = forbidden.filter(b => intersects(b, window));
  for (let y = 0; y < window.height; y++) {
    let row = 0;
    for (let x = 0; x < window.width; x++) {
      const gx = x + window.left, gy = y + window.top, q = (gy * width + gx) * 4;
      const expected = surface ? surfaceColor(surface, gx, gy) : color;
      let delta = Math.abs(data[q + 3] - expected[3]);
      if (data[q + 3] > 16 || expected[3] > 16) for (let c = 0; c < 3; c++) delta = Math.max(delta, Math.abs(data[q + c] - expected[c]));
      row += !removable[y * window.width + x] && delta > FIGURE_SPACE.backgroundNoise ? 1 : 0;
      elements[(y + 1) * stride + x + 1] = elements[y * stride + x + 1] + row;
    }
  }
  const count = (box: FigureBox) => {
    const l = box.left - window.left, t = box.top - window.top, r = l + box.width, b = t + box.height;
    return elements[b * stride + r] - elements[t * stride + r] - elements[b * stride + l] + elements[t * stride + l];
  };
  return { anchor, window, elements, stride, count, obstacles, eraseGuard, canvasWidth: width };
}

export function figureOverlapPosition(space: NonNullable<ReturnType<typeof prepareFigureOverlap>>, width: number, height: number, maxRatio: number, align: "left" | "centre" | "right" = "centre") {
  const { anchor, window, obstacles } = space;
  const cx = anchor.left + anchor.width / 2, cy = anchor.top + anchor.height / 2;
  const preferredX = align === "left" ? anchor.left + 1 : align === "right" ? anchor.left + anchor.width - width - 1 : Math.round(cx - width / 2), preferredY = Math.round(cy - height / 2);
  const dx = Math.min(48, Math.max(8, Math.ceil(anchor.width / 4))), dy = Math.min(24, Math.max(4, Math.ceil(anchor.height / 4)));
  const minimumMargin = Math.ceil(space.canvasWidth * .01), after = space.canvasWidth - anchor.left - anchor.width;
  const leftMargin = Math.max(minimumMargin, anchor.left <= space.canvasWidth * .15 ? anchor.left : 0);
  const rightMargin = Math.max(minimumMargin, after <= space.canvasWidth * .15 ? after : 0);
  // Keep the original local search when an aligned candidate cannot fit.
  const centredX = Math.round(cx - width / 2);
  const left = Math.max(window.left, leftMargin, Math.min(centredX - dx, preferredX), Math.floor(cx - width + 1));
  const right = Math.min(window.left + window.width - width, space.canvasWidth - rightMargin - width, Math.max(centredX + dx, preferredX), Math.floor(cx));
  const top = Math.max(window.top, preferredY - dy, Math.floor(cy - height + 1)), bottom = Math.min(window.top + window.height - height, preferredY + dy, Math.floor(cy));
  let best: { position: FigureBox; pixels: number; ratio: number; distance: number; aligned: boolean } | null = null;
  for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) {
    const position = { left: x, top: y, width, height };
    if (obstacles.some(b => intersects(position, b))) continue;
    const pixels = space.count(position), ratio = pixels / (width * height), distance = (x - preferredX) ** 2 + (y - preferredY) ** 2, aligned = x === preferredX;
    if (ratio > maxRatio || best && (Number(!aligned) > Number(!best.aligned) || aligned === best.aligned && (ratio > best.ratio || ratio === best.ratio && distance >= best.distance))) continue;
    best = { position, pixels, ratio, distance, aligned };
  }
  return best;
}

// A one-pixel local-color halo changes fewer pixels than an opaque rectangle.
// Its complete footprint is included in placement and obstacle checks.
export function figureOverlapTreatment(glyphs: Buffer, width: number, height: number, position: FigureBox, color: number[], surface?: FigureBackground, treatment = FIGURE_OVERLAP.treatment): Buffer {
  const out = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let alpha = treatment === "backing" ? 255 : 0;
    if (treatment === "halo") for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const sx = x + dx, sy = y + dy;
      if (sx >= 0 && sx < width && sy >= 0 && sy < height) alpha = Math.max(alpha, glyphs[(sy * width + sx) * 4 + 3]);
    }
    const p = (y * width + x) * 4, bg = surface ? surfaceColor(surface, position.left + x, position.top + y) : color;
    const foreground = glyphs[p + 3] / 255, backing = alpha / 255 * bg[3] / 255, a = foreground + backing * (1 - foreground);
    for (let c = 0; c < 3; c++) out[p + c] = a ? Math.round((glyphs[p + c] * foreground + bg[c] * backing * (1 - foreground)) / a) : 0;
    out[p + 3] = Math.round(a * 255);
  }
  return out;
}
