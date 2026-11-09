import { createHash } from "node:crypto";

export const AVATAR_EDGE = 256;

// A separate one-way namespace keeps image addresses from revealing member-page identifiers.
export function avatarSeed(publicId: string): string {
  return createHash("sha256").update("tomola-avatar-v1\0").update(publicId).digest("hex");
}

export function automaticAvatarUrl(publicId: string): string {
  return `/avatars/${avatarSeed(publicId)}.svg`;
}

export function avatarSvg(seed: string): string {
  if (!/^[a-f0-9]{64}$/.test(seed)) throw new Error("Invalid avatar seed");
  // Muted, achromatic geometry: no letters, flags, faces or culture-specific symbols.
  let cells = "";
  for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) {
    const value = Number.parseInt(seed[y * 5 + x], 16);
    if (value < 8) cells += `<rect x="${20 + x * 44}" y="${20 + y * 44}" width="40" height="40" rx="${value % 3 * 8}"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><rect width="256" height="256" fill="#e5e5e5"/><g fill="#737373">${cells}</g></svg>`;
}
