import { MOTION_LIMITS, MediaError } from "./media.ts";

// Walk compressed containers without decoding pixels. Limits apply to the full
// canvas on every frame, including delta frames with tiny compressed payloads.
export function inspectMotion(bytes: Buffer) {
  const gif = /^GIF8[79]a$/.test(bytes.toString("ascii", 0, 6));
  const webp = bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  if (!gif && !webp) return null;
  let width = 0, height = 0, frames = 0, durationMs = 0;
  const need = (offset: number, size: number) => { if (offset + size > bytes.length) throw new MediaError("type"); };
  const check = () => {
    if (width > MOTION_LIMITS.width || height > MOTION_LIMITS.height || frames > MOTION_LIMITS.frames || width * height * frames > MOTION_LIMITS.pixels || durationMs > MOTION_LIMITS.durationMs) throw new MediaError("too_large", 413);
  };
  if (gif) {
    need(0, 13);
    width = bytes.readUInt16LE(6); height = bytes.readUInt16LE(8); check();
    let offset = 13 + ((bytes[10] & 128) ? 3 * (2 ** ((bytes[10] & 7) + 1)) : 0), delay = 100, ended = false;
    const blocks = () => {
      for (;;) { need(offset, 1); const size = bytes[offset++]; if (!size) return; need(offset, size); offset += size; }
    };
    while (offset < bytes.length) {
      const kind = bytes[offset++];
      if (kind === 0x3b) { ended = true; break; }
      if (kind === 0x21) {
        need(offset, 1); const label = bytes[offset++];
        if (label === 0xf9) { need(offset, 6); if (bytes[offset] !== 4 || bytes[offset + 5] !== 0) throw new MediaError("type"); delay = bytes.readUInt16LE(offset + 2) * 10; }
        blocks();
      } else if (kind === 0x2c) {
        need(offset, 9);
        const x = bytes.readUInt16LE(offset), y = bytes.readUInt16LE(offset + 2), w = bytes.readUInt16LE(offset + 4), h = bytes.readUInt16LE(offset + 6);
        if (!w || !h || x + w > width || y + h > height) throw new MediaError("type");
        const packed = bytes[offset + 8]; offset += 9 + ((packed & 128) ? 3 * (2 ** ((packed & 7) + 1)) : 0);
        need(offset, 1); offset++; blocks();
        frames++; durationMs += delay; delay = 100; check();
      } else throw new MediaError("type");
    }
    if (!ended || !frames || !width || !height) throw new MediaError("type");
  } else {
    need(0, 12);
    let animated = false;
    if (bytes.readUInt32LE(4) + 8 !== bytes.length) throw new MediaError("type");
    for (let offset = 12; offset < bytes.length;) {
      need(offset, 8);
      const kind = bytes.toString("ascii", offset, offset + 4), size = bytes.readUInt32LE(offset + 4), start = offset + 8;
      need(start, size + size % 2);
      if (kind === "VP8X") { if (size !== 10) throw new MediaError("type"); animated = !!(bytes[start] & 2); width = bytes.readUIntLE(start + 4, 3) + 1; height = bytes.readUIntLE(start + 7, 3) + 1; if (animated) check(); }
      if (kind === "ANMF") {
        if (size < 16 || !animated) throw new MediaError("type");
        const x = bytes.readUIntLE(start, 3) * 2, y = bytes.readUIntLE(start + 3, 3) * 2, w = bytes.readUIntLE(start + 6, 3) + 1, h = bytes.readUIntLE(start + 9, 3) + 1;
        if (x + w > width || y + h > height) throw new MediaError("type");
        frames++; durationMs += bytes.readUIntLE(start + 12, 3); check();
      }
      offset = start + size + size % 2;
    }
    if (!animated) return null;
    if (!frames || !width || !height) throw new MediaError("type");
  }
  return { width, height, frames, durationMs, format: gif ? "gif" : "webp" };
}
