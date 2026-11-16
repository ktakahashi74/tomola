import type { FigureReading, FigureRegion } from "./figure";

export type FigureBox = { left: number; top: number; width: number; height: number };
export const FIGURE_SPACE = { adjacentDelta: 6, backgroundNoise: 16, faintLineContrast: 32, faintLineWidth: 3, faintLineLength: 24, contrast: 40, glyphFringe: 4, guard: 2, maxSpeckPixels: 9, maxSpeckDiameter: 3, maxWindowWidth: 2048, maxWindowHeight: 512, maxWindowPixels: 1048576, horizontalMargin: 192, verticalMargin: 96 } as const;
export const inside = (b: FigureBox, x: number, y: number) => x >= b.left && x < b.left + b.width && y >= b.top && y < b.top + b.height;
export const boxArea = (b: FigureBox) => b.width * b.height;
export function figureBox(region: Pick<FigureRegion, "x" | "y" | "width" | "height">, width: number, height: number): FigureBox {
  const left = Math.floor(region.x * width), top = Math.floor(region.y * height);
  return { left, top, width: Math.min(width, Math.ceil((region.x + region.width) * width)) - left, height: Math.min(height, Math.ceil((region.y + region.height) * height)) - top };
}
const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
const luminance = (color: ArrayLike<number>) => color[0] * .299 + color[1] * .587 + color[2] * .114;
export function background(data: Buffer, width: number, height: number, box: FigureBox): number[] {
  const samples: number[][] = [[], [], [], []];
  for (let y = Math.max(0, box.top - 2); y < Math.min(height, box.top + box.height + 2); y++) for (let x = Math.max(0, box.left - 2); x < Math.min(width, box.left + box.width + 2); x++) {
    if (!inside(box, x, y)) for (let c = 0; c < 4; c++) samples[c].push(data[(y * width + x) * 4 + c]);
  }
  return samples.map((values, c) => values.length ? median(values) : data[c]);
}
function difference(data: Buffer, p: number, q: number): number {
  let d = Math.abs(data[p * 4 + 3] - data[q * 4 + 3]);
  if (data[p * 4 + 3] > 16 || data[q * 4 + 3] > 16) for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(data[p * 4 + c] - data[q * 4 + c]));
  return d;
}
const padded = (box: FigureBox, amount: number, width: number, height: number): FigureBox => ({
  left: Math.max(0, box.left - amount), top: Math.max(0, box.top - amount),
  width: Math.min(width, box.left + box.width + amount) - Math.max(0, box.left - amount),
  height: Math.min(height, box.top + box.height + amount) - Math.max(0, box.top - amount),
});
export type FigureInk = { box: FigureBox; points: number[]; protectedPoints?: number[]; lineCount: number; lineHeights: number[]; uncertain: boolean };

// Keep components touching the OCR box and nearby character-sized fragments.
// Enclosures and components outside the small recovery margin remain obstacles.
export function measureFigureInk(data: Buffer, width: number, height: number, box: FigureBox, others: FigureBox[], threshold: number = FIGURE_SPACE.contrast): FigureInk {
  const color = background(data, width, height, box), light = luminance(color) > 128;
  let final: FigureInk = { box, points: [], lineCount: 0, lineHeights: [], uncertain: false };
  for (let padding = 8; padding <= 64; padding *= 2) {
    const search = padded(box, padding, width, height), n = boxArea(search), mask = new Uint8Array(n), seen = new Uint8Array(n);
    for (let y = 0; y < search.height; y++) for (let x = 0; x < search.width; x++) {
      const gx = x + search.left, gy = y + search.top, p = (gy * width + gx) * 4;
      if (others.some(b => inside(b, gx, gy))) continue;
      const contrast = color[3] <= 16 ? data[p + 3] - color[3] : (light ? 1 : -1) * (luminance(color) - (data[p] * .299 + data[p + 1] * .587 + data[p + 2] * .114));
      if (contrast > threshold) mask[y * search.width + x] = 1;
    }
    const components: { box: FigureBox; points: number[]; touches: boolean }[] = [], tinyPoints = new Set<number>();
    for (let p = 0; p < n; p++) {
      if (!mask[p] || seen[p]) continue;
      const queue = [p]; seen[p] = 1;
      let left = search.width, right = 0, top = search.height, bottom = 0, touches = false;
      for (let k = 0; k < queue.length; k++) {
        const at = queue[k], x = at % search.width, y = Math.floor(at / search.width);
        left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
        touches ||= inside(box, x + search.left, y + search.top);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy, q = ny * search.width + nx;
          if (nx >= 0 && nx < search.width && ny >= 0 && ny < search.height && mask[q] && !seen[q]) { seen[q] = 1; queue.push(q); }
        }
      }
      const b = { left: left + search.left, top: top + search.top, width: right - left + 1, height: bottom - top + 1 };
      if (queue.length < 4) for (const at of queue) tinyPoints.add((Math.floor(at / search.width) + search.top) * width + at % search.width + search.left);
      if (queue.length >= 4 && !(b.width > box.width * .8 && b.height <= 3) && !(b.height > box.height * .8 && b.width <= 2 && (b.left <= box.left || b.left + b.width >= box.left + box.width || b.top < box.top || b.top + b.height > box.top + box.height))) {
        components.push({ box: b, points: queue.map(at => (Math.floor(at / search.width) + search.top) * width + at % search.width + search.left), touches });
      }
    }
    const recovery = padded(box, 8, width, height);
    const eligible = components.filter(c => {
      const b = c.box;
      let encloses = b.left < box.left && b.top < box.top && b.left + b.width > box.left + box.width && b.top + b.height > box.top + box.height;
      if (!encloses && components.some(other => other !== c && other.box.left >= b.left + 4 && other.box.top >= b.top + 4 && other.box.left + other.box.width <= b.left + b.width - 4 && other.box.top + other.box.height <= b.top + b.height - 4)) {
        const edges = [0, 0, 0, 0];
        for (const p of c.points) {
          const x = p % width, y = Math.floor(p / width);
          if (x === b.left) edges[0]++; if (x === b.left + b.width - 1) edges[1]++;
          if (y === b.top) edges[2]++; if (y === b.top + b.height - 1) edges[3]++;
        }
        encloses = edges[0] >= b.height * .65 && edges[1] >= b.height * .65 && edges[2] >= b.width * .65 && edges[3] >= b.width * .65;
      }
      const oversized = b.width > box.width + 16 || b.height > box.height + 16;
      return !encloses && !oversized;
    });
    // A brightening background can join white glyphs into a huge component.
    // Retry its segmentation at half the strong foreground contrast; retain
    // enclosures and the existing erasure fringe rather than swallowing fills.
    if (!light && threshold === FIGURE_SPACE.contrast && components.some(c => c.touches && !eligible.includes(c) && (!(c.box.left < box.left && c.box.top < box.top && c.box.left + c.box.width > box.left + box.width && c.box.top + c.box.height > box.top + box.height) || figureBacking(data, width, height, { ...final, box })))) {
      const contrasts: number[] = [];
      for (let y = box.top; y < box.top + box.height; y++) for (let x = box.left; x < box.left + box.width; x++) {
        const p = (y * width + x) * 4;
        contrasts.push(color[3] <= 16 ? data[p + 3] - color[3] : (light ? 1 : -1) * (luminance(color) - luminance(data.subarray(p, p + 3))));
      }
      contrasts.sort((a, b) => a - b);
      const stronger = (contrasts[Math.floor(contrasts.length * .95)] ?? 0) * .5;
      if (stronger > FIGURE_SPACE.contrast) return measureFigureInk(data, width, height, box, others, stronger);
    }
    const primary = eligible.filter(c => c.touches);
    const characterHeight = primary.length ? median(primary.map(c => c.box.height)) : box.height;
    const chosen = eligible.filter(c => c.touches ||
      c.box.left >= recovery.left && c.box.top >= recovery.top && c.box.left + c.box.width <= recovery.left + recovery.width && c.box.top + c.box.height <= recovery.top + recovery.height &&
      c.box.width <= characterHeight * 1.5 && c.box.height <= characterHeight * 1.5 &&
      primary.some(p => c.box.top < p.box.top + p.box.height && p.box.top < c.box.top + c.box.height));
    if (!chosen.length) return final;
    const points = chosen.flatMap(c => c.points), rows = new Uint32Array(height);
    let left = width, right = 0, top = height, bottom = 0;
    for (const p of points) { const x = p % width, y = Math.floor(p / width); left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); rows[y]++; }
    const lineHeights: number[] = []; let start = -1, end = -1;
    for (let y = top; y <= bottom + 3; y++) {
      if ((rows[y] ?? 0) >= 2) { if (start < 0) start = y; end = y; }
      else if (start >= 0 && y - end >= 3) { lineHeights.push(end - start + 1); start = -1; }
    }
    // Closely set lines may have fewer than three empty raster rows. Cluster
    // substantial character components by vertical centre as a second signal;
    // small dots and radicals cannot create extra lines on their own.
    const substantial = chosen.filter(c => c.box.height >= Math.max(...chosen.map(c => c.box.height)) * .5);
    const groups: { centre: number; count: number; top: number; bottom: number }[] = [];
    const typicalHeight = median(substantial.map(c => c.box.height));
    for (const c of substantial.sort((a, b) => a.box.top + a.box.height / 2 - b.box.top - b.box.height / 2)) {
      const centre = c.box.top + c.box.height / 2, previous = groups.at(-1);
      if (previous && centre - previous.centre <= typicalHeight * .65) {
        previous.centre = (previous.centre * previous.count + centre) / ++previous.count;
        previous.top = Math.min(previous.top, c.box.top); previous.bottom = Math.max(previous.bottom, c.box.top + c.box.height);
      } else groups.push({ centre, count: 1, top: c.box.top, bottom: c.box.top + c.box.height });
    }
    const measuredLines = groups.length > lineHeights.length ? groups.map(g => g.bottom - g.top) : lineHeights;
    const tight = { left, top, width: right - left + 1, height: bottom - top + 1 };
    const clipped = left === search.left && left > 0 || top === search.top && top > 0 || right + 1 === search.left + search.width && right + 1 < width || bottom + 1 === search.top + search.height && bottom + 1 < height;
    const own = new Set(points), protectedPoints: number[] = [];
    for (let p = 0; p < n; p++) if (mask[p]) {
      const global = (Math.floor(p / search.width) + search.top) * width + p % search.width + search.left;
      if (own.has(global)) continue;
      // Tiny disconnected antialias fragments inside the OCR label belong to
      // its erasure fringe. Substantial components and exterior marks do not.
      let fringe = false;
      if (tinyPoints.has(global) && inside(box, global % width, Math.floor(global / width))) {
        for (let dy = -FIGURE_SPACE.glyphFringe; dy <= FIGURE_SPACE.glyphFringe && !fringe; dy++) for (let dx = -FIGURE_SPACE.glyphFringe; dx <= FIGURE_SPACE.glyphFringe; dx++) {
          const x = global % width + dx;
          if (x >= 0 && x < width && own.has(global + dy * width + dx)) { fringe = true; break; }
        }
      }
      if (!fringe) protectedPoints.push(global);
    }
    final = { box: tight, points, protectedPoints, lineCount: measuredLines.length, lineHeights: measuredLines, uncertain: clipped };
    if (!clipped) break;
  }
  return final;
}

export function measureFigure(data: Buffer, width: number, height: number, reading: FigureReading): FigureInk[] {
  const boxes = reading.regions.map(r => figureBox(r, width, height));
  return boxes.map((box, i) => measureFigureInk(data, width, height, box, boxes.filter((_, j) => i !== j)));
}

// Exact maximal rectangles containing the complete anchor, in O(width*height).
// Keep a range of aspect ratios; a smaller rectangle may fit words better.
export function figureRectangles(mask: Uint8Array, width: number, height: number, anchor: FigureBox): FigureBox[] {
  const heights = new Int32Array(width), stack = new Int32Array(width + 1), candidates = new Map<number, FigureBox>();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) heights[x] = mask[y * width + x] ? heights[x] + 1 : 0;
    let size = 0;
    for (let x = 0; x <= width; x++) {
      const h = x === width ? 0 : heights[x];
      while (size && heights[stack[size - 1]] > h) {
        const rh = heights[stack[--size]], left = size ? stack[size - 1] + 1 : 0;
        const b = { left, top: y + 1 - rh, width: x - left, height: rh };
        if (left > anchor.left || b.top > anchor.top || x < anchor.left + anchor.width || y + 1 < anchor.top + anchor.height) continue;
        const bucket = Math.round(Math.log2(b.width / b.height) * 4), previous = candidates.get(bucket);
        if (!previous || boxArea(b) > boxArea(previous)) candidates.set(bucket, b);
      }
      stack[size++] = x;
    }
  }
  return [...candidates.values()].sort((a, b) => boxArea(b) - boxArea(a));
}

// Restore a local color field rather than painting a single median color. Ring
// medians reject isolated ink; opposite edges preserve linear color gradients.
export function figureBackgroundPatch(data: Buffer, width: number, height: number, box: FigureBox, ink?: FigureInk, surface?: FigureBackground): Buffer {
  if (surface?.backing && ink) {
    const out = Buffer.alloc(boxArea(box) * 4);
    for (let y = 0; y < box.height; y++) for (let x = 0; x < box.width; x++) out.set(surfaceColor(surface, box.left + x, box.top + y), (y * box.width + x) * 4);
    return out;
  }
  if (surface && ink) {
    // Fit geometry with the smooth model, but erase using nearby real colors.
    // The nearest agreeing pair preserves curved gradients and fill edges.
    const out = Buffer.alloc(boxArea(box) * 4), search = padded(box, 32, width, height), n = boxArea(search), excluded = new Uint8Array(n);
    for (const p of [...ink.points, ...ink.protectedPoints ?? []]) for (let dy = -FIGURE_SPACE.glyphFringe; dy <= FIGURE_SPACE.glyphFringe; dy++) for (let dx = -FIGURE_SPACE.glyphFringe; dx <= FIGURE_SPACE.glyphFringe; dx++) {
      const x = p % width + dx, y = Math.floor(p / width) + dy;
      if (inside(search, x, y)) excluded[(y - search.top) * search.width + x - search.left] = 1;
    }
    const nearest = Array.from({ length: 4 }, () => new Int32Array(n).fill(-1));
    for (let p = 0; p < n; p++) {
      const x = p % search.width;
      nearest[0][p] = x ? !excluded[p - 1] ? p - 1 : nearest[0][p - 1] : -1;
      nearest[2][p] = p >= search.width ? !excluded[p - search.width] ? p - search.width : nearest[2][p - search.width] : -1;
    }
    for (let p = n - 1; p >= 0; p--) {
      const x = p % search.width;
      nearest[1][p] = x + 1 < search.width ? !excluded[p + 1] ? p + 1 : nearest[1][p + 1] : -1;
      nearest[3][p] = p + search.width < n ? !excluded[p + search.width] ? p + search.width : nearest[3][p + search.width] : -1;
    }
    const global = (p: number) => ((Math.floor(p / search.width) + search.top) * width + p % search.width + search.left);
    for (let y = 0; y < box.height; y++) for (let x = 0; x < box.width; x++) {
      const p = (box.top + y - search.top) * search.width + box.left + x - search.left;
      let best = Infinity, a = -1, b = -1, fraction = .5;
      for (let axis = 0; axis < 4; axis += 2) {
        const l = nearest[axis][p], r = nearest[axis + 1][p]; if (l < 0 || r < 0) continue;
        const span = (r - l) / (axis ? search.width : 1), delta = difference(data, global(l), global(r));
        const score = span + (delta > FIGURE_SPACE.backgroundNoise ? 64 : 0);
        if (score < best) { best = score; a = global(l); b = global(r); fraction = (p - l) / (r - l); }
      }
      const fallback = surfaceColor(surface, box.left + x, box.top + y);
      for (let c = 0; c < 4; c++) out[(y * box.width + x) * 4 + c] = a < 0 ? fallback[c] : Math.round(data[a * 4 + c] * (1 - fraction) + data[b * 4 + c] * fraction);
    }
    return out;
  }
  const out = Buffer.alloc(boxArea(box) * 4), fallback = background(data, width, height, ink?.box ?? box);
  // Close outlines can cover the sampling edges around the erasure fringe.
  // Reject protected marks and color outliers before interpolating the field.
  const protectedPoints = new Set(ink?.protectedPoints);
  const sample = (x: number, y: number, horizontal: boolean) => {
    const values: number[][] = [[], [], [], []];
    for (let d = -2; d <= 2; d++) {
      const sx = horizontal ? x : x + d, sy = horizontal ? y + d : y;
      if (sx < 0 || sx >= width || sy < 0 || sy >= height) continue;
      const p = sy * width + sx, q = p * 4;
      if (protectedPoints.has(p) || Math.abs(data[q + 3] - fallback[3]) > FIGURE_SPACE.backgroundNoise) continue;
      if ((fallback[3] > 16 || data[q + 3] > 16) && Math.max(Math.abs(data[q] - fallback[0]), Math.abs(data[q + 1] - fallback[1]), Math.abs(data[q + 2] - fallback[2])) > FIGURE_SPACE.backgroundNoise) continue;
      for (let c = 0; c < 4; c++) values[c].push(data[q + c]);
    }
    return values.map((channel, c) => channel.length ? median(channel) : fallback[c]);
  };
  const horizontal = box.left > 0 && box.left + box.width < width;
  const vertical = box.top > 0 && box.top + box.height < height;
  const edges = [new Uint8Array(box.height * 4), new Uint8Array(box.height * 4), new Uint8Array(box.width * 4), new Uint8Array(box.width * 4)];
  for (let y = 0; y < box.height; y++) {
    edges[0].set(sample(box.left - 1, box.top + y, true), y * 4);
    edges[1].set(sample(box.left + box.width, box.top + y, true), y * 4);
  }
  for (let x = 0; x < box.width; x++) {
    edges[2].set(sample(box.left + x, box.top - 1, false), x * 4);
    edges[3].set(sample(box.left + x, box.top + box.height, false), x * 4);
  }
  for (let y = 0; y < box.height; y++) for (let x = 0; x < box.width; x++) {
    const a = (x + 1) / (box.width + 1), b = (y + 1) / (box.height + 1);
    for (let c = 0; c < 4; c++) {
      const h = edges[0][y * 4 + c] * (1 - a) + edges[1][y * 4 + c] * a;
      const v = edges[2][x * 4 + c] * (1 - b) + edges[3][x * 4 + c] * b;
      out[(y * box.width + x) * 4 + c] = Math.round(horizontal && vertical ? (h + v) / 2 : horizontal ? h : vertical ? v : fallback[c]);
    }
  }
  return out;
}

export function restoreFigureBackground(data: Buffer, width: number, height: number, box: FigureBox): Buffer {
  const out = Buffer.from(data), patch = figureBackgroundPatch(data, width, height, box);
  for (let y = 0; y < box.height; y++) patch.copy(out, ((box.top + y) * width + box.left) * 4, y * box.width * 4, (y + 1) * box.width * 4);
  return out;
}

// A smooth placement model must also describe the actual colors restored at
// every source glyph. Otherwise erasing text across a fill edge is uncertain.
export function figureBackgroundPatchAgrees(patch: Buffer, box: FigureBox, width: number, ink: FigureInk, surface: FigureBackground): boolean {
  return ink.points.every(p => {
    const x = p % width, y = Math.floor(p / width), q = ((y - box.top) * box.width + x - box.left) * 4;
    return surfaceMatches(surface, patch.subarray(q, q + 4), x, y);
  });
}

// A fallback model is used only after the original placement has failed.
export type FigureBackground = { box: FigureBox; channels: number[][]; bounds?: FigureBox; backing?: { box: FigureBox; top: number[][]; bottom: number[][] } };
// Paired dark edges across nearly the complete text width certify a small
// backing. Search stays between those edges and within the glyph fringe at
// either end; color changes beneath a translucent backing do not enlarge it.
function figureBacking(data: Buffer, width: number, height: number, ink: FigureInk): FigureBackground | undefined {
  const box = ink.box;
  if (box.height > 32 || box.width > 256 || luminance(background(data, width, height, box)) > 128) return;
  const sample = (x: number, y: number) => Array.from(data.subarray((y * width + x) * 4, (y * width + x + 1) * 4));
  const edges: number[] = [];
  for (const side of [-1, 1]) {
    let best = 0, edge = -1;
    for (let d = 3; d <= 12; d++) {
      const y = side < 0 ? box.top - d : box.top + box.height - 1 + d;
      if (y < 2 || y + 2 >= height) continue;
      const deltas: number[] = [];
      for (let x = box.left + 3; x < box.left + box.width - 3; x++) deltas.push(luminance(sample(x, y + side * 2)) - luminance(sample(x, y - side * 2)));
      const score = median(deltas);
      if (deltas.filter(d => d > FIGURE_SPACE.adjacentDelta).length >= deltas.length * .85 && score > FIGURE_SPACE.backgroundNoise && score > best) { best = score; edge = y - side * 2; }
    }
    if (edge < 0) return;
    edges.push(edge);
  }
  const bounds = { left: Math.max(0, box.left - 4), top: edges[0], width: Math.min(width, box.left + box.width + 4) - Math.max(0, box.left - 4), height: edges[1] - edges[0] + 1 };
  if (bounds.top > box.top || bounds.top + bounds.height < box.top + box.height) return;
  const colors = (y: number) => Array.from({ length: bounds.width }, (_, dx) => [0, 1, 2, 3].map(c => median([-1, 0, 1].map(d => sample(Math.max(0, Math.min(width - 1, bounds.left + dx + d)), y)[c]))));
  return { box, channels: [], bounds, backing: { box: bounds, top: colors(bounds.top), bottom: colors(bounds.top + bounds.height - 1) } };
}
function surfaceMatches(surface: FigureBackground, color: ArrayLike<number>, x: number, y: number): boolean {
  const backing = surface.backing;
  if (backing) {
    if (!inside(backing.box, x, y)) return false;
    const dx = x - backing.box.left, top = backing.top[dx], bottom = backing.bottom[dx];
    return [0, 1, 2, 3].every(c => color[c] >= Math.min(top[c], bottom[c]) - FIGURE_SPACE.backgroundNoise && color[c] <= Math.max(top[c], bottom[c]) + FIGURE_SPACE.backgroundNoise);
  }
  return surfaceColor(surface, x, y).every((v, c) => Math.abs(color[c] - v) <= FIGURE_SPACE.backgroundNoise);
}
function surfaceColor(surface: FigureBackground, x: number, y: number): number[] {
  const backing = surface.backing;
  if (backing) {
    const dx = Math.max(0, Math.min(backing.box.width - 1, x - backing.box.left)), fraction = Math.max(0, Math.min(1, (y - backing.box.top) / Math.max(1, backing.box.height - 1)));
    return backing.top[dx].map((v, c) => Math.round(v * (1 - fraction) + backing.bottom[dx][c] * fraction));
  }
  return surface.channels.map(c => Math.max(0, Math.min(255, Math.round(c[0] + c[1] * (x - surface.box.left) / surface.box.width + c[2] * (y - surface.box.top) / surface.box.height))));
}
// Robust spatial samples follow smooth color changes without raising the
// per-pixel noise allowance. Reject models with weak support or steep slopes.
function figureBackgroundSurface(data: Buffer, width: number, height: number, ink: FigureInk): FigureBackground | undefined {
  if (!ink.points.length) return;
  const backing = figureBacking(data, width, height, ink);
  if (backing) return backing;
  const box = ink.box, excluded = new Set<number>([...ink.points, ...ink.protectedPoints ?? []]);

  const samples: { x: number; y: number; color: number[] }[] = [], step = Math.max(4, Math.ceil(Math.sqrt(boxArea(box) / 3000)));
  const reference = luminance(background(data, width, height, box)), light = reference > 128;
  for (let y = box.top; y < box.top + box.height; y += step) for (let x = box.left; x < box.left + box.width; x += step) {
    const pixels: number[][] = [];
    for (let sy = y; sy < Math.min(y + step, box.top + box.height); sy++) for (let sx = x; sx < Math.min(x + step, box.left + box.width); sx++) {
      const p = sy * width + sx;
      const color = Array.from(data.subarray(p * 4, p * 4 + 4));
      if (!excluded.has(p) && (box.height > 32 || (light ? reference - luminance(color) : luminance(color) - reference) <= FIGURE_SPACE.contrast)) pixels.push(color);
    }
    if (!pixels.length) continue;
    pixels.sort((a, b) => luminance(a) - luminance(b));
    const middle = pixels.slice(Math.floor(pixels.length / 4), Math.max(1, Math.ceil(pixels.length * .75)));
    samples.push({ x: (x + (Math.min(step, box.left + box.width - x) - 1) / 2 - box.left) / box.width,
      y: (y + (Math.min(step, box.top + box.height - y) - 1) / 2 - box.top) / box.height,
      color: [0, 1, 2, 3].map(c => middle.reduce((sum, p) => sum + p[c], 0) / middle.length) });
  }
  let kept = samples, channels: number[][] = [];
  for (let iteration = 0; iteration < 4; iteration++) {
    if (kept.length < 12 || kept.length < samples.length * .6) return;
    const matrix = Array.from({ length: 3 }, () => Array(7).fill(0));
    for (const s of kept) {
      const v = [1, s.x, s.y];
      for (let r = 0; r < 3; r++) { for (let c = 0; c < 3; c++) matrix[r][c] += v[r] * v[c]; for (let c = 0; c < 4; c++) matrix[r][c + 3] += v[r] * s.color[c]; }
    }
    for (let r = 0; r < 3; r++) {
      if (Math.abs(matrix[r][r]) < 1e-6) return;
      const d = matrix[r][r]; for (let c = r; c < 7; c++) matrix[r][c] /= d;
      for (let k = 0; k < 3; k++) if (k !== r) { const f = matrix[k][r]; for (let c = r; c < 7; c++) matrix[k][c] -= f * matrix[r][c]; }
    }
    channels = Array.from({ length: 4 }, (_, c) => matrix.map(row => row[c + 3]));
    kept = samples.filter(s => s.color.every((v, c) => Math.abs(v - channels[c][0] - channels[c][1] * s.x - channels[c][2] * s.y) <= FIGURE_SPACE.backgroundNoise));
  }
  if (kept.length < 12 || kept.length < samples.length * .6 || channels.some(c => Math.abs(c[1]) / box.width > FIGURE_SPACE.adjacentDelta || Math.abs(c[2]) / box.height > FIGURE_SPACE.adjacentDelta)) return;

  // Without verified edges, keep small dark labels inside their existing ink.
  return { box, channels, bounds: !light && box.height <= 32 && box.width <= 256 ? box : undefined };
}

export type FigureSpaceContext = { obstacles: FigureBox[]; speckGuards: FigureBox[] };
export function prepareFigureSpace(width: number, height: number, measured: FigureInk[]): FigureSpaceContext {
  return { obstacles: measured.map(m => padded(m.box, 2, width, height)), speckGuards: measured.map(m => padded(m.box, 4, width, height)) };
}

// Bound all per-label raster work. A label larger than the window is left intact.
export function figureSpaceWindow(anchor: FigureBox, width: number, height: number): FigureBox {
  const w = Math.min(width, FIGURE_SPACE.maxWindowWidth, anchor.width + FIGURE_SPACE.horizontalMargin * 2);
  const h = Math.min(height, FIGURE_SPACE.maxWindowHeight, anchor.height + FIGURE_SPACE.verticalMargin * 2, Math.floor(FIGURE_SPACE.maxWindowPixels / w));
  return { left: Math.max(0, Math.min(width - w, anchor.left - Math.floor((w - anchor.width) / 2))),
    top: Math.max(0, Math.min(height - h, anchor.top - Math.floor((h - anchor.height) / 2))), width: w, height: h };
}

// Only narrow, straight, low-contrast rules may join the background. Check
// matching background on both sides so edges of broad fills remain obstacles.
function allowFaintFigureLines(data: Buffer, width: number, height: number, nearBackground: Uint8Array, blocked: Uint8Array, color: number[]): void {
  const faint = new Uint8Array(width * height), allowed = new Uint8Array(width * height);
  for (let p = 0; p < faint.length; p++) {
    let delta = Math.abs(data[p * 4 + 3] - color[3]);
    if (color[3] > 16 || data[p * 4 + 3] > 16) for (let c = 0; c < 3; c++) delta = Math.max(delta, Math.abs(data[p * 4 + c] - color[c]));
    faint[p] = !blocked[p] && delta <= FIGURE_SPACE.faintLineContrast ? 1 : 0;
  }
  for (const vertical of [true, false]) {
    const across = vertical ? width : height, along = vertical ? height : width;
    const at = (x: number, y: number) => vertical ? y * width + x : x * width + y;
    const thin = new Uint8Array(width * height);
    for (let y = 0; y < along; y++) for (let x = 0; x < across;) {
      if (nearBackground[at(x, y)]) { x++; continue; }
      const start = x;
      let lowContrast = true;
      while (x < across && !nearBackground[at(x, y)]) { lowContrast &&= Boolean(faint[at(x, y)]); x++; }
      // Sample beyond the immediate antialias fringe as well as checking that
      // both adjacent pixels already belong to the background tolerance.
      const before = start - 2, after = x + 1;
      if (!lowContrast || before < 0 || after >= across || x - start > FIGURE_SPACE.faintLineWidth ||
        !nearBackground[at(before, y)] || !nearBackground[at(after, y)] ||
        blocked[at(before, y)] || blocked[at(after, y)] || difference(data, at(before, y), at(after, y)) > FIGURE_SPACE.adjacentDelta) continue;
      for (let k = start; k < x; k++) thin[at(k, y)] = 1;
    }
    for (let x = 0; x < across; x++) for (let y = 0; y < along;) {
      const start = y;
      let run = 0, longest = 0;
      // Erased glyphs can interrupt a rule with background pixels. Continue
      // along its fixed raster coordinate, stopping at ink or label keep-outs.
      while (y < along && !blocked[at(x, y)] && (thin[at(x, y)] || nearBackground[at(x, y)])) {
        run = thin[at(x, y)] ? run + 1 : 0;
        longest = Math.max(longest, run); y++;
      }
      if (longest >= FIGURE_SPACE.faintLineLength) for (let k = start; k < y; k++) if (thin[at(x, k)]) allowed[at(x, k)] = 1;
      y++;
    }
  }
  for (let p = 0; p < allowed.length; p++) if (allowed[p]) nearBackground[p] = 1;
}

export function figureSpace(data: Buffer, width: number, height: number, index: number, measured: FigureInk[], occupied: FigureBox[] = [], context = prepareFigureSpace(width, height, measured), guard: number = FIGURE_SPACE.guard, surface?: FigureBackground): { anchor: FigureBox; erase: FigureBox; window: FigureBox; mask: Uint8Array; rectangles: FigureBox[]; seed: number; surface?: FigureBackground } {
  const anchor = measured[index].box, erase = padded(anchor, FIGURE_SPACE.glyphFringe, width, height);
  const window = figureSpaceWindow(anchor, width, height), w = window.width, h = window.height, count = w * h;
  const localAnchor = { ...anchor, left: anchor.left - window.left, top: anchor.top - window.top };
  if (anchor.width > w || anchor.height > h) return { anchor, erase, window, mask: new Uint8Array(count), rectangles: [] as FigureBox[], seed: -1 };
  const virtual = Buffer.alloc(count * 4);
  for (let y = 0; y < h; y++) data.copy(virtual, y * w * 4, ((window.top + y) * width + window.left) * 4, ((window.top + y) * width + window.left + w) * 4);
  const removable = figureEraseMask(width, height, index, measured, window, surface?.bounds);
  const restored = surface ? Buffer.alloc(boxArea(erase) * 4) : figureBackgroundPatch(data, width, height, erase, measured[index]);
  if (surface) for (let y = 0; y < erase.height; y++) for (let x = 0; x < erase.width; x++) restored.set(surfaceColor(surface, erase.left + x, erase.top + y), (y * erase.width + x) * 4);
  for (let y = 0; y < erase.height; y++) for (let x = 0; x < erase.width; x++) {
    const lx = erase.left + x - window.left, ly = erase.top + y - window.top;
    if (lx >= 0 && lx < w && ly >= 0 && ly < h && removable[ly * w + lx]) restored.copy(virtual, (ly * w + lx) * 4, (y * erase.width + x) * 4, (y * erase.width + x + 1) * 4);
  }
  const blocked = new Uint8Array(count);
  const obstacles = [...context.obstacles.filter((_, i) => i !== index), ...occupied.map(b => padded(b, 2, width, height))];
  for (const b of obstacles) for (let y = Math.max(0, b.top - window.top); y < Math.min(h, b.top + b.height - window.top); y++) {
    const left = Math.max(0, b.left - window.left), right = Math.min(w, b.left + b.width - window.left);
    if (left < right) blocked.fill(1, y * w + left, y * w + right);
  }
  const reached = new Uint8Array(count), queue = new Int32Array(count), nearBackground = new Uint8Array(count);
  let head = 0, tail = 0, seed = -1, best = Infinity;
  const color = background(data, width, height, anchor), ring = padded(localAnchor, 3, w, h);
  for (let p = 0; p < count; p++) {
    const q = p * 4, expected = surface ? surfaceColor(surface, p % w + window.left, Math.floor(p / w) + window.top) : color;
    nearBackground[p] = surface ? (surfaceMatches(surface, virtual.subarray(q, q + 4), p % w + window.left, Math.floor(p / w) + window.top) ? 1 : 0) : Math.abs(virtual[q + 3] - expected[3]) <= FIGURE_SPACE.backgroundNoise &&
      (expected[3] <= 16 && virtual[q + 3] <= 16 || Math.max(Math.abs(virtual[q] - expected[0]), Math.abs(virtual[q + 1] - expected[1]), Math.abs(virtual[q + 2] - expected[2])) <= FIGURE_SPACE.backgroundNoise) ? 1 : 0;
  }
  allowFaintFigureLines(virtual, w, h, nearBackground, blocked, color);
  for (let y = ring.top; y < ring.top + ring.height; y++) for (let x = ring.left; x < ring.left + ring.width; x++) {
    const p = y * w + x;
    if (inside(localAnchor, x, y) || blocked[p]) continue;
    const expected = surface ? surfaceColor(surface, x + window.left, y + window.top) : color;
    let d = Math.abs(expected[3] - virtual[p * 4 + 3]);
    if (expected[3] > 16) for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(expected[c] - virtual[p * 4 + c]));
    if (d < best) { seed = p; best = d; }
  }
  const visit = (p: number, q: number) => {
    // A soft edge can connect a broad fill to the background by tiny steps.
    // Fallback surfaces require agreement with the model at every new pixel.
    if (!reached[q] && !blocked[q] && (surface ? nearBackground[q] : nearBackground[p] && nearBackground[q] || difference(virtual, p, q) <= FIGURE_SPACE.adjacentDelta)) { reached[q] = 1; queue[tail++] = q; }
  };
  if (seed >= 0) { reached[seed] = 1; queue[tail++] = seed; }
  while (head < tail) {
    const p = queue[head++], x = p % w;
    if (x) visit(p, p - 1); if (x + 1 < w) visit(p, p + 1);
    if (p >= w) visit(p, p - w); if (p + w < count) visit(p, p + w);
  }
  // Preserve the small isolated-texture policy, including its label keep-out.
  const checked = new Uint8Array(count);
  for (let p = 0; p < count; p++) {
    if (reached[p] || blocked[p] || checked[p]) continue;
    let size = 1; queue[0] = p; checked[p] = 1;
    let l = p % w, r = l, t = Math.floor(p / w), b = t;
    for (let k = 0; k < size; k++) {
      const q = queue[k], x = q % w, y = Math.floor(q / w);
      l = Math.min(l, x); r = Math.max(r, x); t = Math.min(t, y); b = Math.max(b, y);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy, next = ny * w + nx;
        if (nx >= 0 && nx < w && ny >= 0 && ny < h && !reached[next] && !blocked[next] && !checked[next]) { checked[next] = 1; queue[size++] = next; }
      }
    }
    if (l > 0 && t > 0 && r + 1 < w && b + 1 < h && size <= FIGURE_SPACE.maxSpeckPixels && r - l < FIGURE_SPACE.maxSpeckDiameter && b - t < FIGURE_SPACE.maxSpeckDiameter && Math.max(r - l + 1, b - t + 1) <= 2 * Math.min(r - l + 1, b - t + 1) && !context.speckGuards.some(g => inside(g, l + window.left, t + window.top))) for (let k = 0; k < size; k++) reached[queue[k]] = 1;
  }
  const safe = new Uint8Array(count), distance = new Uint32Array(count);
  for (let p = 0; p < count; p++) distance[p] = reached[p] ? guard + 1 : 0;
  for (let p = 0; p < count; p++) {
    const x = p % w;
    if (x) distance[p] = Math.min(distance[p], distance[p - 1] + 1);
    if (p >= w) { distance[p] = Math.min(distance[p], distance[p - w] + 1); if (x) distance[p] = Math.min(distance[p], distance[p - w - 1] + 1); if (x + 1 < w) distance[p] = Math.min(distance[p], distance[p - w + 1] + 1); }
  }
  for (let p = count - 1; p >= 0; p--) {
    const x = p % w;
    if (x + 1 < w) distance[p] = Math.min(distance[p], distance[p + 1] + 1);
    if (p + w < count) { distance[p] = Math.min(distance[p], distance[p + w] + 1); if (x) distance[p] = Math.min(distance[p], distance[p + w - 1] + 1); if (x + 1 < w) distance[p] = Math.min(distance[p], distance[p + w + 1] + 1); }
    safe[p] = distance[p] > guard ? 1 : 0;
  }
  const limit = surface?.bounds ? { ...surface.bounds, left: surface.bounds.left - window.left, top: surface.bounds.top - window.top } : undefined;
  if (limit) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (!inside(limit, x, y)) safe[y * w + x] = 0;
  let candidates = figureRectangles(safe, w, h, localAnchor);
  const centre = { left: Math.floor(localAnchor.left + localAnchor.width / 2), top: Math.floor(localAnchor.top + localAnchor.height / 2), width: 1, height: 1 };
  if (!candidates.length && guard > FIGURE_SPACE.guard) candidates = figureRectangles(safe, w, h, centre);
  // A shorter translation can use a taller central rectangle even when the
  // complete source box fits only a shallow strip. fitLabel still checks all ink.
  if (surface) candidates = [...candidates, ...figureRectangles(safe, w, h, centre)].sort((a, b) => boxArea(b) - boxArea(a));
  const rectangles = candidates.map(b => ({ ...b, left: b.left + window.left, top: b.top + window.top }));
  return { anchor, erase, window, mask: safe, rectangles, seed, surface };
}

export function figureSurfaceSpace(data: Buffer, width: number, height: number, index: number, measured: FigureInk[], occupied: FigureBox[], context: FigureSpaceContext) {
  const model = figureBackgroundSurface(data, width, height, measured[index]);
  return model ? figureSpace(data, width, height, index, measured, occupied, context, FIGURE_SPACE.guard, model) : undefined;
}

export function figureEraseMask(width: number, height: number, index: number, measured: FigureInk[], window: FigureBox = { left: 0, top: 0, width, height }, backing?: FigureBox): Uint8Array {
  const mask = new Uint8Array(boxArea(window));
  for (const p of measured[index].points) for (let dy = -FIGURE_SPACE.glyphFringe; dy <= FIGURE_SPACE.glyphFringe; dy++) for (let dx = -FIGURE_SPACE.glyphFringe; dx <= FIGURE_SPACE.glyphFringe; dx++) {
    const x = p % width + dx, y = Math.floor(p / width) + dy;
    if (inside(window, x, y) && (!backing || inside(backing, x, y)) && !measured.some((m, j) => j !== index && inside(m.box, x, y))) mask[(y - window.top) * window.width + x - window.left] = 1;
  }
  for (const p of measured[index].protectedPoints ?? []) for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const x = p % width + dx, y = Math.floor(p / width) + dy;
    if (inside(window, x, y)) mask[(y - window.top) * window.width + x - window.left] = 0;
  }
  return mask;
}
