import type { FigureReading, FigureRegion } from "./figure";

export type FigureBox = { left: number; top: number; width: number; height: number };
export const FIGURE_SPACE = { adjacentDelta: 6, backgroundNoise: 16, contrast: 40, glyphFringe: 4, guard: 2, maxSpeckPixels: 9, maxSpeckDiameter: 3, maxWindowWidth: 2048, maxWindowHeight: 512, maxWindowPixels: 262144, horizontalMargin: 192, verticalMargin: 96 } as const;
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
export function measureFigureInk(data: Buffer, width: number, height: number, box: FigureBox, others: FigureBox[]): FigureInk {
  const color = background(data, width, height, box), light = luminance(color) > 128;
  let final: FigureInk = { box, points: [], lineCount: 0, lineHeights: [], uncertain: false };
  for (let padding = 8; padding <= 64; padding *= 2) {
    const search = padded(box, padding, width, height), n = boxArea(search), mask = new Uint8Array(n), seen = new Uint8Array(n);
    for (let y = 0; y < search.height; y++) for (let x = 0; x < search.width; x++) {
      const gx = x + search.left, gy = y + search.top, p = (gy * width + gx) * 4;
      if (others.some(b => inside(b, gx, gy))) continue;
      const contrast = color[3] <= 16 ? data[p + 3] - color[3] : (light ? 1 : -1) * (luminance(color) - (data[p] * .299 + data[p + 1] * .587 + data[p + 2] * .114));
      if (contrast > FIGURE_SPACE.contrast) mask[y * search.width + x] = 1;
    }
    const components: { box: FigureBox; points: number[]; touches: boolean }[] = [];
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
      if (queue.length >= 4 && !(b.width > box.width * .8 && b.height <= 3) && !(b.height > box.height * .8 && b.width <= 2)) {
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
      if (!own.has(global)) protectedPoints.push(global);
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
export function figureBackgroundPatch(data: Buffer, width: number, height: number, box: FigureBox, ink?: FigureInk): Buffer {
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

export function figureSpace(data: Buffer, width: number, height: number, index: number, measured: FigureInk[], occupied: FigureBox[] = [], context = prepareFigureSpace(width, height, measured), guard: number = FIGURE_SPACE.guard) {
  const anchor = measured[index].box, erase = padded(anchor, FIGURE_SPACE.glyphFringe, width, height);
  const window = figureSpaceWindow(anchor, width, height), w = window.width, h = window.height, count = w * h;
  const localAnchor = { ...anchor, left: anchor.left - window.left, top: anchor.top - window.top };
  if (anchor.width > w || anchor.height > h) return { anchor, erase, window, mask: new Uint8Array(count), rectangles: [] as FigureBox[], seed: -1 };
  const virtual = Buffer.alloc(count * 4);
  for (let y = 0; y < h; y++) data.copy(virtual, y * w * 4, ((window.top + y) * width + window.left) * 4, ((window.top + y) * width + window.left + w) * 4);
  const removable = figureEraseMask(width, height, index, measured, window);
  const restored = figureBackgroundPatch(data, width, height, erase, measured[index]);
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
    const q = p * 4;
    nearBackground[p] = Math.abs(virtual[q + 3] - color[3]) <= FIGURE_SPACE.backgroundNoise &&
      (color[3] <= 16 && virtual[q + 3] <= 16 || Math.max(Math.abs(virtual[q] - color[0]), Math.abs(virtual[q + 1] - color[1]), Math.abs(virtual[q + 2] - color[2])) <= FIGURE_SPACE.backgroundNoise) ? 1 : 0;
  }
  for (let y = ring.top; y < ring.top + ring.height; y++) for (let x = ring.left; x < ring.left + ring.width; x++) {
    const p = y * w + x;
    if (inside(localAnchor, x, y) || blocked[p]) continue;
    let d = Math.abs(color[3] - virtual[p * 4 + 3]);
    if (color[3] > 16) for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(color[c] - virtual[p * 4 + c]));
    if (d < best) { seed = p; best = d; }
  }
  const visit = (p: number, q: number) => {
    if (!reached[q] && !blocked[q] && (nearBackground[p] && nearBackground[q] || difference(virtual, p, q) <= FIGURE_SPACE.adjacentDelta)) { reached[q] = 1; queue[tail++] = q; }
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
  let candidates = figureRectangles(safe, w, h, localAnchor);
  // Extra clearance may trim the old glyph box even when a shorter translation
  // fits safely. Keep its centre as the search anchor; placement still checks
  // the complete translated ink rectangle and preserves the alignment edge.
  if (!candidates.length && guard > FIGURE_SPACE.guard) candidates = figureRectangles(safe, w, h, {
    left: Math.floor(localAnchor.left + localAnchor.width / 2), top: Math.floor(localAnchor.top + localAnchor.height / 2), width: 1, height: 1,
  });
  const rectangles = candidates.map(b => ({ ...b, left: b.left + window.left, top: b.top + window.top }));
  return { anchor, erase, window, mask: safe, rectangles, seed };
}

export function figureEraseMask(width: number, height: number, index: number, measured: FigureInk[], window: FigureBox = { left: 0, top: 0, width, height }): Uint8Array {
  const mask = new Uint8Array(boxArea(window));
  for (const p of measured[index].points) for (let dy = -FIGURE_SPACE.glyphFringe; dy <= FIGURE_SPACE.glyphFringe; dy++) for (let dx = -FIGURE_SPACE.glyphFringe; dx <= FIGURE_SPACE.glyphFringe; dx++) {
    const x = p % width + dx, y = Math.floor(p / width) + dy;
    if (inside(window, x, y) && !measured.some((m, j) => j !== index && inside(m.box, x, y))) mask[(y - window.top) * window.width + x - window.left] = 1;
  }
  for (const p of measured[index].protectedPoints ?? []) for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const x = p % width + dx, y = Math.floor(p / width) + dy;
    if (inside(window, x, y)) mask[(y - window.top) * window.width + x - window.left] = 0;
  }
  return mask;
}
