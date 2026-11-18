import sharp from "sharp";

// Invented diagram: a blank start, transparent margin, thin lines and text.
// Raw stacked frames avoid importing anybody's artwork into the repository.
export async function motionImage(format: "gif" | "webp" = "gif", frames = 8, width = 160, height = 100, frameMs?: number) {
  const pages: Buffer[] = [];
  for (let frame = 0; frame < frames; frame++) {
    const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><rect x="4" y="4" width="${width - 8}" height="${height - 8}" fill="white"/>${frame ? `<path d="M12 ${height - 16} L${width - 12} ${12 + frame % Math.max(1, height - 40)}" stroke="#245aac" fill="none" stroke-width="1"/><text x="12" y="28" font-size="18">x = ${frame}</text>` : ""}</svg>`;
    pages.push(await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer());
  }
  const image = sharp(Buffer.concat(pages), { raw: { width, height: height * frames, channels: 4, pageHeight: height } });
  const delay = Array.from({ length: frames }, (_, i) => frameMs ?? 80 + i % 3 * 20);
  const bytes = format === "gif" ? await image.gif({ delay, loop: 3 }).toBuffer() : await image.withMetadata({ exif: { IFD0: { Artist: "Synthetic fixture" } } }).webp({ delay, loop: 3, lossless: true }).toBuffer();
  return { bytes, delay, frames, width, height };
}
