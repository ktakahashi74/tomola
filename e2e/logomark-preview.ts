import type { Page } from "@playwright/test";
import { captureScreenshot } from "./helpers";

const escape = (text: string) => text.replace(/[&<>"]/g, character => `&#${character.charCodeAt(0)};`);

// These are size and crop simulations, not screenshots of native browser or OS chrome.
// A query avoids Playwright aborting /favicon.ico while request interception is active.
export async function captureLogomarkPreviews(page: Page, preview?: { title: string; description: string; image: string }) {
  if (!process.env.E2E_EVIDENCE_DIR) return;
  const content = preview ? `
    <h1>Image-free article: link preview crop comparison</h1>
    <p>Actual article metadata; simulated 2:1 landscape and square thumbnail layouts.</p>
    <main>${["/icons/icon-maskable-512.png", preview.image].map((image, index) => `
      <section><h2>${index ? "Selected share image" : "Home-screen image candidate"}</h2>
        <article class="large"><img src="${escape(image)}" alt="tomola"><div><b>${escape(preview.title)}</b><p>${escape(preview.description)}</p></div></article>
        <article class="small"><img src="${escape(image)}" alt="tomola"><div><b>${escape(preview.title)}</b><p>${escape(preview.description)}</p></div></article>
      </section>`).join("")}</main>` : `
    <h1>Tab and home-screen size simulations</h1>
    <p>Tabs: 16 CSS px. Home screens: 60 CSS px. Native rendering still needs device checks.</p>
    <h2>Light tab / dark tab</h2>
    <main>${["light", "dark"].map(theme => `<section class="tab ${theme}">
      <div><img src="/icons/icon.svg" width="16" height="16" alt="">tomola — SVG</div>
      <div><img src="/favicon.ico?preview=1" width="16" height="16" alt="">tomola — ICO</div>
    </section>`).join("")}</main>
    <h2>Home screens</h2><main class="homes">
      <section><img class="iphone" src="/icons/apple-touch-icon.png" width="60" height="60" alt="tomola"><p>iPhone rounded square</p></section>
      <section><img class="android" src="/icons/icon-maskable-512.png" width="60" height="60" alt="tomola"><p>Android circular mask</p></section>
    </main>`;
  const route = "**/__logomark-preview";
  await page.route(route, request => request.fulfill({ contentType: "text/html", body: `<!doctype html><html lang="en"><meta charset="utf-8"><title>Icon preview</title>
    <style>
      body{margin:32px;font:16px system-ui;color:#1f1f1f;background:#f4f3f0}h1{font-size:24px}h2{font-size:18px}
      main{display:flex;gap:24px}section{width:480px}article{background:white;border:1px solid #ccc;border-radius:12px;overflow:hidden;margin-bottom:24px}
      article div{padding:16px}article p{margin:8px 0 0}.large img{display:block;width:480px;height:240px;object-fit:cover}
      .small{display:flex;align-items:center}.small img{width:96px;height:96px;object-fit:cover}.small div{padding:12px}.small p{font-size:14px}
      .tab{padding:12px;border-radius:12px}.tab div{display:flex;align-items:center;gap:10px;padding:10px}.light{background:#fff}.dark{background:#292a2d;color:#f1f3f4}
      .homes{background:#719086;padding:24px;border-radius:16px}.homes section{width:220px;text-align:center}.iphone{border-radius:14px}.android{border-radius:50%}
    </style>${content}</html>` }));
  try {
    await page.setViewportSize({ width: 1080, height: 900 });
    await page.goto("/__logomark-preview");
    await page.waitForFunction(() => [...document.images].every(image => image.complete));
    const broken = await page.evaluate(() => [...document.images].filter(image => !image.naturalWidth).map(image => image.src));
    if (broken.length) throw new Error(`Preview images did not decode: ${broken.join(", ")}`);
    await captureScreenshot(page, { path: preview ? "share-card-crops.png" : "tabs-and-home-screens.png", fullPage: true }, "logomark");
  } finally { if (!page.isClosed()) await page.unroute(route); }
}
