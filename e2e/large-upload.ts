import sharp from "sharp";
import { expect, type Page } from "@playwright/test";
import { MEDIA_LIMITS } from "../app/lib/media";

// An uncompressed, valid PNG above the ordinary request limit. Its pixels
// compress well after avatar resizing, so this tests input rather than storage.
export async function largeUpload() {
  const buffer = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#789" } }).png({ compressionLevel: 0 }).toBuffer();
  expect(buffer.length).toBeGreaterThan(2 * 1024 * 1024);
  expect(buffer.length).toBeLessThan(MEDIA_LIMITS.inputBytes);
  return { name: "large-portrait.png", mimeType: "image/png", buffer };
}

export async function uploadResponse(page: Page, path: string) {
  const response = await page.waitForResponse(response => response.request().method() === "POST"
    && [path, `${path}.data`].includes(new URL(response.url()).pathname));
  expect(response.ok()).toBe(true);
  console.info(`Image upload: ${new URL(response.url()).pathname}`);
}
