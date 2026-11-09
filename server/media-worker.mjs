import sharp from "sharp";
import { MEDIA_LIMITS } from "../app/lib/media.ts";

// Untrusted decoders run in a disposable process. No input filenames or error details leave it.
sharp.cache(false);
sharp.concurrency(1);
const avatar = process.argv[2] === "avatar";
function format(bytes) {
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "jpeg";
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "png";
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "webp";
  return null;
}
function animated(bytes, type) {
  if (type === "png") {
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const size = bytes.readUInt32BE(offset);
      if (bytes.toString("ascii", offset + 4, offset + 8) === "acTL") return true;
      offset += size + 12;
    }
  }
  if (type === "webp") {
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const kind = bytes.toString("ascii", offset, offset + 4), size = bytes.readUInt32LE(offset + 4);
      if (kind === "ANIM" || kind === "ANMF" || (kind === "VP8X" && size >= 1 && (bytes[offset + 8] & 2))) return true;
      offset += size + 8 + size % 2;
    }
  }
  return false;
}
try {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > MEDIA_LIMITS.inputBytes) { process.exitCode = 3; break; }
    chunks.push(chunk);
  }
  if (!process.exitCode) {
    const bytes = Buffer.concat(chunks), type = format(bytes);
    if (!type || animated(bytes, type)) process.exitCode = 2;
    else {
      const options = { failOn: "warning", limitInputPixels: MEDIA_LIMITS.pixels };
      const metadata = await sharp(bytes, options).metadata();
      if (metadata.format !== type || (metadata.pages ?? 1) > 1) process.exitCode = 2;
      else if (!metadata.width || !metadata.height || metadata.width * metadata.height > MEDIA_LIMITS.pixels) process.exitCode = 3;
      else {
        // Default output removes EXIF, XMP, ICC and comments; rotate applies EXIF orientation first.
        const convert = (retry) => sharp(bytes, options).rotate()
          .timeout({ seconds: Math.max(1, Math.floor(MEDIA_LIMITS.processingMs / 1000) - 1) })
          .resize(avatar ? { width: 256, height: 256, fit: "cover", position: "centre" } : { width: MEDIA_LIMITS.edge, height: MEDIA_LIMITS.edge, fit: "inside", withoutEnlargement: true })
          .webp({ lossless: !retry && type === "png", quality: retry ? 80 : 85, effort: 4 })
          .toBuffer({ resolveWithObject: true });
        let output = await convert(false);
        if (output.data.length > MEDIA_LIMITS.storedBytes) output = await convert(true);
        if (output.data.length > MEDIA_LIMITS.storedBytes) process.exitCode = 3;
        else {
          const header = Buffer.alloc(8);
          header.writeUInt32BE(output.info.width); header.writeUInt32BE(output.info.height, 4);
          process.stdout.write(Buffer.concat([header, output.data]));
        }
      }
    }
  }
} catch (error) {
  process.exitCode = /pixel limit/i.test(String(error)) ? 3 : 4;
}
