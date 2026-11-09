// Two sources: public/icons/icon.svg is the small tab mark (also served as the
// SVG favicon), public/icons/logomark.svg is the full mark for home screens and
// share images. Replace either, then run `node scripts/generate-icons.ts` from the
// repository root and commit the generated files too. Requires only sharp.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const resizeOptions = { fit: "contain", background: "#00000000" } as const;

// Use uncompressed 32-bit DIB frames, including the legacy transparency mask,
// so the ICO fallback also works in browsers that cannot read PNG-based ICOs.
async function favicon(source: Buffer): Promise<Buffer> {
  const sizes = [16, 32, 48];
  const directory = Buffer.alloc(6 + sizes.length * 16);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(sizes.length, 4);
  const frames: Buffer[] = [];
  let offset = directory.length;
  for (const [index, size] of sizes.entries()) {
    const rgba = await sharp(source).resize(size, size, resizeOptions).ensureAlpha().raw().toBuffer();
    const maskStride = Math.ceil(size / 32) * 4;
    const frame = Buffer.alloc(40 + size * size * 4 + maskStride * size);
    frame.writeUInt32LE(40, 0);
    frame.writeInt32LE(size, 4);
    frame.writeInt32LE(size * 2, 8);
    frame.writeUInt16LE(1, 12);
    frame.writeUInt16LE(32, 14);
    frame.writeUInt32LE(size * size * 4, 20);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const pixel = (y * size + x) * 4;
        const target = 40 + ((size - 1 - y) * size + x) * 4;
        frame[target] = rgba[pixel + 2];
        frame[target + 1] = rgba[pixel + 1];
        frame[target + 2] = rgba[pixel];
        frame[target + 3] = rgba[pixel + 3];
        if (rgba[pixel + 3] === 0) {
          const mask = 40 + size * size * 4 + (size - 1 - y) * maskStride + (x >> 3);
          frame[mask] |= 0x80 >> (x & 7);
        }
      }
    }
    const entry = 6 + index * 16;
    directory[entry] = size;
    directory[entry + 1] = size;
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(frame.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    frames.push(frame);
    offset += frame.length;
  }
  return Buffer.concat([directory, ...frames]);
}

export async function generateIcons(publicDir = path.resolve(import.meta.dirname, "../public")): Promise<void> {
  const tab = await readFile(path.join(publicDir, "icons/icon.svg"));
  const source = await readFile(path.join(publicDir, "icons/logomark.svg"));
  const render = (size: number) => sharp(source).resize(size, size, resizeOptions).png().toBuffer();
  const onPaper = async (size: number, markSize: number) => sharp({
    create: { width: size, height: size, channels: 3, background: "#FFFFFF" },
  }).composite([{
    input: await render(markSize), left: (size - markSize) / 2, top: (size - markSize) / 2,
  }]).removeAlpha().png().toBuffer();

  // Measure the outer corners of the drawn pixels (not transparent and not the
  // white paper ground), so any mark shape stays inside the maskable safe circle.
  const pixels = await sharp(await render(400)).ensureAlpha().raw().toBuffer();
  let radius = 0;
  for (let y = 0; y < 400; y++) for (let x = 0; x < 400; x++) {
    const at = (y * 400 + x) * 4;
    if (pixels[at + 3] !== 0 && Math.min(pixels[at], pixels[at + 1], pixels[at + 2]) < 250) {
      radius = Math.max(radius, Math.hypot(Math.abs(x + 0.5 - 200) + 0.5, Math.abs(y + 0.5 - 200) + 0.5));
    }
  }
  // Leave a one-pixel rasterization allowance and keep the placement integral.
  const safeRadius = 512 * 0.4 - 1;
  const maskableSize = radius > safeRadius ? 2 * Math.floor(200 * safeRadius / radius) : 400;

  // Keep the tab mark's circles, but cut its white t out of the silhouette.
  // Both the outline and the letter come from the same replaceable SVG.
  const whiteTab = tab.toString().replace(/(fill|stroke)="[^"]*"/g, '$1="#FFFFFF"');
  const letter = [...tab.toString().matchAll(/<path\b[^>]*fill="#FFFFFF"[^>]*\/>/g)]
    .map(([element]) => element.replace('fill="#FFFFFF"', 'fill="#000000"')).join("");
  const badge = whiteTab.replace(/(<svg\b[^>]*>)/, `$1<defs><mask id="letter"><rect width="100%" height="100%" fill="#FFFFFF"/>${letter}</mask></defs><g mask="url(#letter)">`)
    .replace("</svg>", "</g></svg>");

  const outputs: [string, Buffer][] = [
    ["favicon.ico", await favicon(tab)],
    ["icons/badge-96.png", await sharp(Buffer.from(badge)).resize(96, 96, resizeOptions).png().toBuffer()],
    ["icons/icon-192.png", await render(192)],
    ["icons/icon-512.png", await render(512)],
    ["icons/icon-maskable-512.png", await onPaper(512, maskableSize)],
    ["icons/apple-touch-icon.png", await onPaper(180, 180)],
    // A 240px mark also survives a centered 2:1 landscape crop of this square.
    ["icons/share-default.png", await onPaper(512, 240)],
  ];
  for (const [file, bytes] of outputs) await writeFile(path.join(publicDir, file), bytes);
}

if (import.meta.main) await generateIcons();
