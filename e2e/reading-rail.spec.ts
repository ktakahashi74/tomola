import { readingActions, readTopicTranslation } from "./helpers";
import fs from "node:fs";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { test } from "./editor-fixture";
import { captureScreenshot, clientHeaders, enMessages as en, state, useMember, waitForClientRoute } from "./helpers";

type Fixture = { topicId: number; noHeadingsId: number; longTocId: number };
const fixture = (): Fixture => JSON.parse(fs.readFileSync(path.join(state().dir, "reading-page.json"), "utf8"));
// Read layout values from CSS so the boundary and measure checks follow their definitions.
const readingCss = fs.readFileSync(new URL("../app/app.css", import.meta.url), "utf8");
const [breakpointEm, centeredBreakpointEm] = [...readingCss
  .matchAll(/@media \(min-width: ([\d.]+)em\) \{(?:(?!@media)[\s\S])*?body:has\(\.reading-toc-sidebar\)/g)]
  .map(match => Number(match[1]));
const navigationBreakpointEm = Number(readingCss
  .match(/@media \(min-width: ([\d.]+)em\) \{\s+\/\*[\s\S]*?\*\/\s+body:has\(\.site-navigation\)/)![1]);
const cjkCharacters = Number(readingCss.match(/--reading-cjk-measure:\s*calc\(([\d.]+)\s*\*/)![1]);

async function readingBreakpoint(page: Page) {
  return page.evaluate(em => Math.ceil(em * parseFloat(getComputedStyle(document.documentElement).fontSize)), breakpointEm);
}

async function centeredReadingBreakpoint(page: Page) {
  return page.evaluate(em => Math.ceil(em * parseFloat(getComputedStyle(document.documentElement).fontSize)), centeredBreakpointEm);
}

async function cssLengths(page: Page, selector: string, variables: string[]) {
  return page.locator(selector).first().evaluate((element, names) => Object.fromEntries(names.map(name => {
    const probe = document.createElement("span");
    probe.style.cssText = "position: absolute; visibility: hidden";
    probe.style.inlineSize = `var(${name})`;
    element.append(probe);
    const pixels = parseFloat(getComputedStyle(probe).inlineSize);
    probe.remove();
    return [name, pixels];
  })), variables);
}

async function signInReader(page: Page, scenario: "layout" | "scroll" | "ai") {
  if (scenario === "ai" || !test.info().project.metadata.publicReading) await useMember(page, `reading_rail_${scenario}@example.com`, `/t/${fixture().topicId}?lang=en`);
}

async function photograph(page: Page, name: string) {
  await captureScreenshot(page, { path: `${name}.png`, animations: "disabled" }, "e2e-reading-rail");
}

test("CJK reading titles add relative spacing while English retains normal spacing and balanced wrapping", async ({ browser }) => {
  const f: { topics: Record<string, number> } = JSON.parse(fs.readFileSync(path.join(state().dir, "reading-layout.json"), "utf8"));
  const context = await browser.newContext({ extraHTTPHeaders: clientHeaders("10.79.0.9") });
  const page = await context.newPage();
  const topicUrl = (lang: string) => `/t/${f.topics[lang]}?lang=${lang}&orig=${f.topics[lang]}`;
  try {
    if (!test.info().project.metadata.publicReading) await useMember(page, "reading_layout@example.com", topicUrl("ja"));
    for (const lang of ["ja", "zh-Hans", "zh-Hant", "ko", "en"]) {
      for (const width of [1366, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(topicUrl(lang));
        await waitForClientRoute(page);
        await page.evaluate(() => document.fonts.ready);
        const title = page.locator(".reading-title");
        await expect(title).toHaveAttribute("lang", lang);
        const metrics = await title.evaluate(element => {
          const style = getComputedStyle(element);
          return {
            size: parseFloat(style.fontSize),
            spacing: style.letterSpacing === "normal" ? 0 : parseFloat(style.letterSpacing),
            wrap: style.getPropertyValue("text-wrap"),
            wordBreak: style.wordBreak,
          };
        });
        expect(metrics.spacing).toBeCloseTo(metrics.size * (lang === "en" ? 0 : 0.04));
        expect(metrics.wrap).toBe("balance");
        if (lang === "ja") expect(metrics.wordBreak).toBe("auto-phrase");
        await expect(title).toBeInViewport();
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
        if (lang === "ja" || lang === "en") {
          const mode = test.info().project.metadata.publicReading ? "public" : "private";
          await captureScreenshot(page, { path: `title-${lang}-${width}-${mode}.png`, animations: "disabled" }, "e2e-reading-title-spacing");
        }
      }
    }
  } finally { await context.close(); }
});

test("body wrapping follows each block's language in full and compact prose", async ({ browser }) => {
  const f: { topics: Record<string, number> } = JSON.parse(fs.readFileSync(path.join(state().dir, "reading-layout.json"), "utf8"));
  const context = await browser.newContext({ extraHTTPHeaders: clientHeaders("10.79.0.11") });
  const page = await context.newPage();
  const topicUrl = (lang: string) => `/t/${f.topics[lang]}?lang=${lang}&orig=${f.topics[lang]}`;
  try {
    if (!test.info().project.metadata.publicReading) await useMember(page, "reading_layout@example.com", topicUrl("ja"));
    for (const lang of ["ja", "zh-Hans", "zh-Hant", "ko", "en"]) {
      for (const width of [390, 1366]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(topicUrl(lang));
        const body = page.locator("[data-reading-body]");
        await expect(body).toHaveAttribute("lang", lang);
        await waitForClientRoute(page);
        await expect(body.locator(":scope > p").first()).toHaveCSS("text-wrap", /^(ja|zh|ko)(-|$)/.test(lang) ? "wrap" : "pretty");
        const styles = await body.evaluate(root => {
          const results: { lang: string; tag: string; compact: boolean; wrap: string }[] = [];
          for (const compact of [false, true]) {
            const probe = document.createElement("div");
            if (compact) probe.className = "longread longread-compact";
            root.append(probe);
            // Include inherited language, regional tags and language changes inside a list or quote.
            for (const language of [null, "ja-JP", "zh-CN", "zh-TW", "en-US", "ko"]) {
              const group = document.createElement("div");
              if (language) group.lang = language;
              probe.append(group);
              for (const tag of ["p", "li", "blockquote"]) {
                const block = document.createElement(tag);
                block.textContent = "Sample passage.";
                if (tag === "li") {
                  const list = document.createElement("ul");
                  group.append(list);
                  list.append(block);
                } else group.append(block);
                for (const element of [block, ...(tag === "p" ? [] : ["en", "ja", "zh-Hant"].map(nestedLanguage => {
                  const paragraph = document.createElement("p");
                  paragraph.lang = nestedLanguage;
                  paragraph.textContent = "Sample passage.";
                  block.append(paragraph);
                  return paragraph;
                }))]) {
                  results.push({
                    lang: element.closest("[lang]")!.getAttribute("lang")!, tag: element.tagName, compact,
                    wrap: getComputedStyle(element).getPropertyValue("text-wrap"),
                  });
                }
              }
            }
            probe.remove();
          }
          return results;
        });
        for (const style of styles) {
          expect(style.wrap, JSON.stringify({ bodyLang: lang, width, ...style })).toBe(/^(ja|zh|ko)(-|$)/i.test(style.lang) ? "wrap" : "pretty");
        }
      }
    }
  } finally { await context.close(); }
});

async function expectContentsIndicator(page: Page) {
  const appearance = await page.locator(".reading-toc-sidebar > nav > ol").evaluate(list => {
    const colors = ["--rule", "--reading-ink", "--reading-ink-strong", "--location-accent"].map(variable => {
      const probe = document.createElement("span");
      probe.style.color = `var(${variable})`;
      list.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });
    const style = getComputedStyle(list);
    return {
      colors,
      ruleWidth: parseFloat(style.borderInlineStartWidth),
      ruleColor: style.borderInlineStartColor,
      padding: parseFloat(style.paddingInlineStart),
      rtl: style.direction === "rtl",
      items: [...list.querySelectorAll("li")].map(item => {
        const link = item.querySelector("a")!;
        const text = getComputedStyle(link);
        const bar = getComputedStyle(item, "::before");
        return {
          current: link.getAttribute("aria-current") === "location",
          color: text.color, weight: text.fontWeight,
          content: bar.content, width: parseFloat(bar.width), colorBar: bar.backgroundColor,
          left: parseFloat(bar.left), right: parseFloat(bar.right),
          top: parseFloat(bar.top), bottom: parseFloat(bar.bottom), height: parseFloat(bar.height),
          itemHeight: item.getBoundingClientRect().height, lineHeight: parseFloat(text.lineHeight),
        };
      }),
    };
  });
  expect(appearance.ruleWidth).toBe(1);
  expect(appearance.ruleColor).toBe(appearance.colors[0]);
  expect(appearance.items.filter(item => item.current)).toHaveLength(1);
  for (const item of appearance.items) {
    expect(item.color).toBe(appearance.colors[item.current ? 2 : 1]);
    if (!item.current) {
      expect(item.content).toBe("none");
      continue;
    }
    expect(item.weight).toBe("700");
    expect(item.content).toBe('""');
    expect(item.width).toBe(3);
    expect(item.colorBar).toBe(appearance.colors[3]);
    expect(appearance.rtl ? item.right : item.left).toBeCloseTo(-appearance.padding - appearance.ruleWidth);
    expect(item.top).toBeGreaterThan(0);
    expect(item.bottom).toBeCloseTo(item.top);
    expect(item.height + item.top + item.bottom).toBeCloseTo(item.itemHeight, 1);
  }
  return appearance.items.find(item => item.current)!;
}

test("contents switch between the side column and folded list at the reading breakpoint", async ({ browser }) => {
  expect(breakpointEm).toBe(navigationBreakpointEm);
  const f = fixture();
  const context = await browser.newContext({ extraHTTPHeaders: clientHeaders("10.79.0.5") });
  const page = await context.newPage();
  try {
    await signInReader(page, "layout");
    const breakpoint = await readingBreakpoint(page);
    for (const url of [`/t/${f.topicId}?lang=en`, ...["ja", "en", "ar", "ur"].map(lang => `/principles?lang=${lang}`)]) {
      await page.setViewportSize({ width: breakpoint - 1, height: 900 });
      await page.goto(url);
      const sidebar = page.locator(".reading-toc-sidebar");
      const folded = page.locator(".reading-toc-folded");
      const body = page.locator(".longread").first();
      await expect(body).toBeVisible();
      const readingWidth = (await body.boundingBox())!.width;
      for (const width of [breakpoint - 1, breakpoint, 1280, 1366, 1680, 390, breakpoint]) {
        await page.setViewportSize({ width, height: 900 });
        if (width >= breakpoint) {
          await expect(sidebar).toBeVisible();
          await expect(folded).toBeHidden();
          const panel = (await sidebar.boundingBox())!;
          const column = (await body.boundingBox())!;
          expect(panel.x).toBeGreaterThanOrEqual(0);
          if (["ar", "ur"].includes(new URL(url, "http://localhost").searchParams.get("lang")!)) {
            expect(panel.x + panel.width).toBeLessThan(column.x);
          } else {
            expect(panel.x).toBeGreaterThan(column.x + column.width);
          }
          expect(panel.x + panel.width).toBeLessThanOrEqual(width);
        } else {
          await expect(sidebar).toBeHidden();
          await expect(folded).toBeVisible();
        }
        if (width >= breakpoint - 1) expect((await body.boundingBox())!.width).toBeCloseTo(readingWidth);
        await expect(page.locator(".site-navigation")).toHaveCount(0);
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
      }
    }
  } finally { await context.close(); }
});

test("reading frames center on wide screens and share space with contents on narrower screens", async ({ browser }) => {
  const f: { topics: Record<string, number>; noHeadingsId: number } = JSON.parse(fs.readFileSync(path.join(state().dir, "reading-layout.json"), "utf8"));
  const context = await browser.newContext({ deviceScaleFactor: 2, extraHTTPHeaders: clientHeaders("10.79.0.6") });
  const page = await context.newPage();
  const topicUrl = (lang: string) => `/t/${f.topics[lang]}?lang=${lang}&orig=${f.topics[lang]}`;
  try {
    if (!test.info().project.metadata.publicReading) await useMember(page, "reading_layout@example.com", topicUrl("ja"));
    const breakpoint = await readingBreakpoint(page);
    const centeredBreakpoint = await centeredReadingBreakpoint(page);
    const cases = [
      ...[1680, 1366, centeredBreakpoint, centeredBreakpoint - 1, breakpoint, breakpoint - 1, 390].map(width => ({ url: topicUrl("ja"), lang: "ja", width, name: "topic-ja" })),
      ...["zh-Hans", "zh-Hant", "ko", "en"].map(lang => ({ url: topicUrl(lang), lang, width: 1366, name: `topic-${lang}` })),
      ...["ja", "ar"].map(lang => ({ url: `/principles?lang=${lang}`, lang, width: 1366, name: `principles-${lang}` })),
    ];
    for (const { url, lang, width, name } of cases) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(url);
      await waitForClientRoute(page);
      await page.evaluate(() => document.fonts.ready);
      const expected = await cssLengths(page, ".reading-column article .longread", ["--site-gutter", "--reading-toc-gap", "--reading-toc-width", "--_lr-size-narrow"]);
      const metrics = await page.evaluate(() => {
        const frame = document.body.getBoundingClientRect();
        const style = getComputedStyle(document.body);
        const text = document.querySelector<HTMLElement>(".reading-column article .longread")!;
        const bounds = text.getBoundingClientRect();
        const textStyle = getComputedStyle(text);
        const header = document.querySelector("header")!.getBoundingClientRect();
        const sidebar = document.querySelector(".reading-toc-sidebar")!.getBoundingClientRect();
        const rtl = textStyle.direction === "rtl";
        const start = frame.left + parseFloat(style.paddingLeft);
        const end = frame.right - parseFloat(style.paddingRight);
        return {
          text: { start: bounds.left, end: bounds.right, width: bounds.width, size: parseFloat(textStyle.fontSize), max: parseFloat(textStyle.maxInlineSize) },
          header: { start: header.left, end: header.right, bottom: header.bottom },
          sidebarTop: sidebar.top,
          titleTop: document.querySelector(".reading-title")!.getBoundingClientRect().top,
          frame: { start, end },
          pair: { start: rtl ? sidebar.left : start, end: rtl ? end : sidebar.right },
          gap: rtl ? start - sidebar.right : sidebar.left - end,
          sidebarWidth: sidebar.width,
          paragraphSize: parseFloat(getComputedStyle(text.querySelector("p")!).fontSize),
        };
      });
      const cjk = ["ja", "zh-Hans", "zh-Hant", "ko"].includes(lang);
      expect(metrics.text.max).toBeCloseTo(metrics.text.size * (cjk ? cjkCharacters : 34));
      if (width >= breakpoint) {
        const centered = width >= centeredBreakpoint ? metrics.frame : metrics.pair;
        expect(Math.abs(centered.start - (width - centered.end))).toBeLessThanOrEqual(2);
        expect(Math.abs(metrics.sidebarTop - metrics.titleTop)).toBeLessThanOrEqual(2);
        expect(metrics.gap).toBeCloseTo(expected["--reading-toc-gap"]);
        expect(metrics.sidebarWidth).toBeCloseTo(expected["--reading-toc-width"]);
      }
      if (lang === "ja") {
        expect(metrics.text.start).toBeCloseTo(metrics.header.start);
        expect(metrics.text.end).toBeCloseTo(metrics.header.end);
        if (width >= breakpoint - 1) expect(metrics.text.width).toBeCloseTo(metrics.text.size * cjkCharacters);
        else {
          expect(metrics.text.width).toBeCloseTo(width - 2 * expected["--site-gutter"]);
          expect(metrics.paragraphSize).toBeCloseTo(expected["--_lr-size-narrow"]);
        }
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
      await photograph(page, `layout-${name}-${width}`);
      if (width >= breakpoint) {
        const sidebar = page.locator(".reading-toc-sidebar");
        const destination = sidebar.locator("nav").getByRole("link").nth(1);
        await destination.click();
        await expect(sidebar.locator("ol")).toHaveCSS("direction", lang === "ar" ? "rtl" : "ltr");
        await expect(sidebar.locator('[aria-current="location"]')).toHaveAttribute("href", await destination.getAttribute("href") ?? "");
        const current = await expectContentsIndicator(page);
        if (name === "topic-ja" && width === 1366) expect(current.itemHeight).toBeCloseTo(2 * current.lineHeight, 1);
        if (width === 1366 && ["topic-ja", "topic-en", "principles-ar"].includes(name)) {
          const bounds = (await sidebar.boundingBox())!;
          await captureScreenshot(page, {
            path: `indicator-${name}-1366.png`, animations: "disabled",
            clip: { x: bounds.x - 8, y: bounds.y - 8, width: bounds.width + 16, height: bounds.height + 16 },
          }, "e2e-reading-rail");
        }
      } else {
        const list = page.locator(".reading-toc-folded ol");
        await expect(list).toHaveCSS("border-inline-start-width", "0px");
        expect(await list.locator("li").first().evaluate(item => getComputedStyle(item, "::before").content)).toBe("none");
      }
    }
    // Pages without headings keep the action column; leaving reading restores the home frame.
    for (const [url, name] of [[`/t/${f.noHeadingsId}?lang=ja&orig=${f.noHeadingsId}`, "no-headings"], ["/?lang=en", "home"]]) {
      // The public-reading fixture enables villages; its member home has a side column.
      if (name === "home" && test.info().project.metadata.publicReading) await useMember(page, "reading_layout@example.com", url);
      await page.goto(url);
      await waitForClientRoute(page);
      await expect(page.locator(".reading-toc")).toHaveCount(0);
      const expected = await cssLengths(page, "body", ["--site-width", "--site-gutter", "--reading-layout-width"]);
      for (const width of name === "home" ? [1024, 1366, 1680] : [breakpoint, centeredBreakpoint - 1, centeredBreakpoint, 1366]) {
        await page.setViewportSize({ width, height: 900 });
        const frame = (await page.locator("body").boundingBox())!;
        const viewport = await page.evaluate(() => document.documentElement.clientWidth);
        const centeredStart = (viewport - expected[name === "no-headings" && width < centeredBreakpoint ? "--reading-layout-width" : "--site-width"]) / 2;
        if (name === "home" && test.info().project.metadata.publicReading) {
          const navigation = (await page.locator(".site-navigation").boundingBox())!;
          const gutter = expected["--site-gutter"];
          expect(navigation.x).toBeCloseTo(Math.max(gutter, centeredStart - navigation.width - gutter), 1);
          expect(frame.x).toBeCloseTo(Math.max(centeredStart, navigation.x + navigation.width + gutter), 1);
        } else expect(frame.x).toBeCloseTo(centeredStart, 1);
        expect(Math.abs(frame.width - expected["--site-width"])).toBeLessThanOrEqual(2);
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
        await photograph(page, `layout-${name}-${width}`);
      }
    }
  } finally { await context.close(); }
});

test("larger browser default text keeps reading frames visible across the contents boundary", async ({ browser }) => {
  const f: { topics: Record<string, number> } = JSON.parse(fs.readFileSync(path.join(state().dir, "reading-layout.json"), "utf8"));
  const context = await browser.newContext({ extraHTTPHeaders: clientHeaders("10.79.0.6") });
  const page = await context.newPage();
  try {
    // Change the browser default, rather than html font-size: media em uses the initial value.
    const session = await context.newCDPSession(page);
    await session.send("Page.setFontSizes", { fontSizes: { standard: 20 } });
    const topic = `/t/${f.topics.ja}?lang=ja&orig=${f.topics.ja}`;
    if (!test.info().project.metadata.publicReading) await useMember(page, "reading_layout@example.com", topic);
    const breakpoint = await readingBreakpoint(page);
    const centeredBreakpoint = await centeredReadingBreakpoint(page);
    for (const [url, name] of [[topic, "topic-ja"], ["/principles?lang=ar", "principles-ar"]]) {
      for (const width of [1200, breakpoint - 1, breakpoint, centeredBreakpoint - 1, centeredBreakpoint, 1680]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(url);
        await waitForClientRoute(page);
        expect(await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize))).toBe(20);
        const sidebar = page.locator(".reading-toc-sidebar");
        await expect(sidebar).toBeVisible({ visible: width >= breakpoint });
        await expect(page.locator(".reading-toc-folded")).toBeVisible({ visible: width < breakpoint });
        for (const selector of ["header", ".reading-column article .longread", ...(width >= breakpoint ? [".reading-toc-sidebar"] : [])]) {
          const blocks = await page.locator(selector).evaluateAll(elements => elements.map(element => {
            const { x, width } = element.getBoundingClientRect();
            return { x, width };
          }));
          expect(blocks.length).toBeGreaterThan(0);
          for (const bounds of blocks) {
            expect(bounds.x).toBeGreaterThanOrEqual(0);
            expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
          }
        }
        const text = page.locator(".reading-column article .longread").first();
        const measure = await text.evaluate(element => {
          const style = getComputedStyle(element);
          return { max: parseFloat(style.maxInlineSize), size: parseFloat(style.fontSize) };
        });
        expect(measure.max).toBeCloseTo(measure.size * (name === "topic-ja" ? cjkCharacters : 34));
        if (width >= breakpoint) {
          const column = (await text.boundingBox())!;
          const panel = (await sidebar.boundingBox())!;
          const frame = (await page.locator("body").boundingBox())!;
          const start = width >= centeredBreakpoint ? frame.x : name === "topic-ja" ? column.x : panel.x;
          const end = width >= centeredBreakpoint ? frame.x + frame.width : name === "topic-ja" ? panel.x + panel.width : column.x + column.width;
          expect(Math.abs(start - (width - end))).toBeLessThanOrEqual(2);
          if (name === "topic-ja") expect(column.width).toBeCloseTo(measure.max);
          const expected = await cssLengths(page, "body", ["--reading-layout-width"]);
          expect(expected["--reading-layout-width"]).toBeLessThanOrEqual(width);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
        await photograph(page, `default-20-${name}-${width}`);
      }
    }
  } finally { await context.close(); }
});

test("side contents start at the title, stick while reading, and stop before the discussion", async ({ browser }) => {
  const f = fixture();
  const context = await browser.newContext({ reducedMotion: "reduce", extraHTTPHeaders: clientHeaders("10.79.0.12") });
  const page = await context.newPage();
  try {
    await signInReader(page, "layout");
    for (const width of [1366, 1100]) {
      await page.setViewportSize({ width, height: 900 });
      for (const id of [f.topicId, f.longTocId, f.noHeadingsId]) {
        await page.goto(`/t/${id}?lang=en&orig=${id}`);
        await waitForClientRoute(page);
        await page.evaluate(() => document.fonts.ready);
        await page.evaluate(() => scrollTo(0, 0));
        const sidebar = page.locator(".reading-toc-sidebar");
        const title = page.locator(".reading-title");
        const initial = (await sidebar.boundingBox())!;
        expect(Math.abs(initial.y - (await title.boundingBox())!.y)).toBeLessThanOrEqual(2);
        const edge = await sidebar.evaluate(element => parseFloat(getComputedStyle(element).top));
        const available = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
        const movement = Math.min((initial.y - edge) / 2, available);
        await page.evaluate(y => scrollTo(0, y), movement);
        await expect.poll(async () => Math.abs((await sidebar.boundingBox())!.y - (initial.y - movement))).toBeLessThanOrEqual(2);
        if (id !== f.noHeadingsId) {
          await page.evaluate(y => scrollTo(0, y), initial.y + 300);
          await expect.poll(async () => Math.abs((await sidebar.boundingBox())!.y - edge)).toBeLessThanOrEqual(2);
        }
        const discussion = page.locator("[data-reading-discussion]");
        await discussion.evaluate(element => scrollTo(0, scrollY + element.getBoundingClientRect().top - innerHeight / 2));
        await expect.poll(async () => {
          const panel = (await sidebar.boundingBox())!;
          return panel.y + panel.height - (await discussion.boundingBox())!.y;
        }).toBeLessThanOrEqual(0);
      }
    }
  } finally { await context.close(); }
});

test("side contents align with the title below an edit notice", async ({ page }) => {
  const f: { topics: Record<string, number> } = JSON.parse(fs.readFileSync(path.join(state().dir, "reading-layout.json"), "utf8"));
  const id = f.topics.ja;
  await page.setViewportSize({ width: 1366, height: 900 });
  await useMember(page, "reading_layout@example.com", `/t/${id}?lang=en&orig=${id}&edited=${id}`);
  const notice = page.getByRole("status").filter({ hasText: en.edited_saved });
  await expect(notice).toBeVisible();
  await waitForClientRoute(page);
  await page.evaluate(() => document.fonts.ready);
  const bounds = await page.evaluate(() => ({
    title: document.querySelector(".reading-title")!.getBoundingClientRect().top,
    sidebar: document.querySelector(".reading-toc-sidebar")!.getBoundingClientRect().top,
    noticeEnd: document.querySelector("article > [role='status']")!.getBoundingClientRect().bottom,
  }));
  expect(bounds.noticeEnd).toBeLessThan(bounds.title);
  expect(Math.abs(bounds.sidebar - bounds.title)).toBeLessThanOrEqual(2);
});

test("the sticky contents follow sections and scroll independently after version changes", async ({ browser }) => {
  const f = fixture();
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, reducedMotion: "reduce", extraHTTPHeaders: clientHeaders("10.79.0.1") });
  let page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await signInReader(page, "scroll");
    await page.goto(`/t/${f.topicId}?lang=en&orig=${f.topicId}`);
    const topic = page.locator(`#p-${f.topicId}`);
    const body = topic.locator("[data-reading-body]");
    const sidebar = topic.locator(".reading-toc-sidebar");
    const active = sidebar.locator('[aria-current="location"]');
    await expect(topic.locator(".reading-toc-sidebar [data-reading-actions]").getByRole("button", { name: en.open_in_ai, exact: true })).toBeVisible();
    await page.evaluate(() => scrollTo(0, 0));
    await expect(active).toHaveCount(0);
    for (const version of ["original", "translation", "original"] as const) {
      if (version === "translation") await readTopicTranslation(topic);
      else if (await body.getAttribute("lang") !== "ja") await topic.getByRole("link", { name: en.show_original, exact: true }).evaluate(link => (link as HTMLElement).click());
      await expect(body).toHaveAttribute("lang", version === "original" ? "ja" : "en");
      const section = body.locator("h2, h3").nth(2);
      await section.evaluate(heading => heading.scrollIntoView());
      const id = await section.getAttribute("id");
      await expect(active).toHaveCount(1);
      await expect(active).toHaveAttribute("href", `#${id}`);
      await expect(active).toHaveText(await section.innerText());
      const next = sidebar.locator("nav").getByRole("link").nth(3);
      await next.click();
      await expect(active).toHaveAttribute("href", await next.getAttribute("href") ?? "");
      await expectContentsIndicator(page);
      expect(new URL(page.url()).hash).toBe(await next.getAttribute("href"));
      await expect(topic.locator(".reading-toc-folded [aria-current]")).toHaveCount(0);
    }
    // A hidden sidebar must not announce a current location, including on resize.
    await page.setViewportSize({ width: 390, height: 900 });
    const narrowSection = body.locator("h2, h3").nth(2);
    await narrowSection.evaluate(heading => heading.scrollIntoView());
    await expect(active).toHaveCount(0);
    await page.setViewportSize({ width: 1366, height: 900 });
    // Rewrapping the wider desktop measure can move the viewport to another section.
    // Reposition before checking that the revealed contents track the requested section.
    await narrowSection.evaluate(heading => heading.scrollIntoView());
    await expect(active).toHaveAttribute("href", `#${await narrowSection.getAttribute("id")}`);
    await page.evaluate(() => scrollTo(0, 0));
    await expect(active).toHaveCount(0);

    // Give this independent fixture its own tab and session scroll-restoration history.
    await page.close();
    page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`/t/${f.longTocId}?lang=en`);
    // Measure the contents panel after client CSS and font metrics settle.
    // Font swaps can change scrollY while anchoring the same visible passage.
    await waitForClientRoute(page);
    await page.evaluate(() => document.fonts.ready);
    const panel = page.locator(".reading-toc-sidebar > nav");
    expect(await panel.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    await expect(page.locator(".reading-toc-sidebar [data-reading-actions]").getByRole("button", { name: en.open_in_ai, exact: true })).toBeInViewport();
    const section = page.locator("[data-reading-body] h2").nth(30);
    await section.evaluate(heading => heading.scrollIntoView());
    const position = await page.evaluate(() => scrollY);
    const current = panel.locator('[aria-current="location"]');
    await expect(current).toHaveAttribute("href", `#${await section.getAttribute("id")}`);
    await expect(current).toBeInViewport();
    expect(await panel.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    expect(await page.evaluate(() => scrollY)).toBe(position);
    const lastLink = panel.getByRole("link").last();
    await lastLink.click();
    await expect(current).toHaveAttribute("href", await lastLink.getAttribute("href") ?? "");
    await expect(current).toBeInViewport();
    await expect(page.locator("[data-reading-body] h2").last()).toBeInViewport();
    await page.evaluate(() => scrollTo(0, 0));
    await expect(current).toHaveCount(0);
    const firstLink = panel.getByRole("link").first();
    await firstLink.click();
    await expect(current).toHaveAttribute("href", await firstLink.getAttribute("href") ?? "");
    await page.locator("[data-reading-body] h2").last().evaluate(heading => heading.scrollIntoView());
    await expect(current).not.toHaveAttribute("href", await firstLink.getAttribute("href") ?? "");
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});

test("both reading entrances share their AI choice, fit each width, and keep Markdown links without scripts", async ({ browser }) => {
  const f = fixture();
  const context = await browser.newContext({ extraHTTPHeaders: clientHeaders("10.79.0.2") });
  const page = await context.newPage();
  const opened: string[] = [];
  await context.route("https://ai.example/**", route => {
    opened.push(route.request().url());
    return route.fulfill({ contentType: "text/html", body: "<title>Fixture AI</title>" });
  });
  try {
    await signInReader(page, "ai");
    for (const width of [1366, 1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/t/${f.topicId}?lang=en&orig=${f.topicId}`);
      await page.evaluate(() => scrollTo(0, 0));
      let byline = await readingActions(page);
      const reply = page.locator("#reply [data-reply-heading]");
      await expect(page.getByRole("button", { name: en.open_in_ai, exact: true })).toHaveCount(2);
      for (const entrance of [byline, reply]) {
        const button = entrance.getByRole("button", { name: en.open_in_ai, exact: true });
        await expect(button).toBeVisible();
        await expect(button).toHaveAttribute("title", en.open_in_ai_help);
        expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(32);
        expect((await entrance.getByRole("button", { name: en.open_in_ai_menu, exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(32);
      }
      await expect(page.locator(".reading-toc-sidebar").getByRole("button", { name: en.open_in_ai, exact: true })).toHaveCount(width >= await readingBreakpoint(page) ? 1 : 0);
      await photograph(page, `${width}-top`);
      await page.locator("[data-reading-body] h2, [data-reading-body] h3").nth(3).evaluate(heading => heading.scrollIntoView());
      if (width === 1366) await expect(page.locator('.reading-toc-sidebar [aria-current="location"]')).toHaveAttribute("href", `#${await page.locator("[data-reading-body] h2, [data-reading-body] h3").nth(3).getAttribute("id")}`);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
      await photograph(page, `${width}-middle`);
      await reply.scrollIntoViewIfNeeded();
      if (width === 1366) await expect(page.locator('.reading-toc-sidebar [aria-current="location"]')).toHaveAttribute("href", await page.locator(".reading-toc-sidebar nav").getByRole("link").last().getAttribute("href") ?? "");
      await photograph(page, `${width}-reply`);
      // Both copies read the same preference and pass the same resource with fresh reading links.
      await page.evaluate(() => localStorage.setItem("tomola.openInAi", JSON.stringify({ provider: "custom", template: "https://ai.example/?prompt={prompt}" })));
      byline = await readingActions(page);
      for (const entrance of [byline, reply]) {
        const before = opened.length;
        await entrance.getByRole("button", { name: en.open_in_ai, exact: true }).click();
        await expect.poll(() => opened.length).toBe(before + 1);
      }
      const resources = opened.slice(-2).map(link => {
        const prompt = new URL(link).searchParams.get("prompt")!;
        const url = new URL(prompt.match(/https?:\/\/[^\s]+/)![0]);
        expect(url.searchParams.has("o")).toBe(!!test.info().project.metadata.publicReading);
        url.searchParams.delete("o");
        expect(url.searchParams.has("k")).toBe(!test.info().project.metadata.publicReading);
        url.searchParams.delete("k");
        return url.href;
      });
      expect(resources[0]).toBe(resources[1]);
      await reply.getByRole("button", { name: en.open_in_ai_menu, exact: true }).click();
      await expect(page.getByRole("menuitem", { name: en.open_in_ai_copy_md, exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
      await page.goto(`/t/${f.noHeadingsId}?lang=en`);
      await page.evaluate(() => scrollTo(0, 0));
      await expect(page.locator(".reading-toc")).toHaveCount(0);
      await expect(page.locator("article [data-reading-byline] details.reading-lang-menu summary")).toBeVisible();
      await expect(page.locator("[data-reading-tools]").getByRole("button", { name: en.open_in_ai, exact: true })).toHaveCount(0);
      byline = await readingActions(page);
      await expect(byline.getByRole("button", { name: en.open_in_ai, exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: en.open_in_ai, exact: true })).toHaveCount(2);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
      await photograph(page, `${width}-no-headings`);
    }
  } finally { await context.close(); }
  for (const width of [1366, 390]) {
    const noJs = await browser.newContext({ javaScriptEnabled: false, viewport: { width, height: 900 }, extraHTTPHeaders: clientHeaders("10.79.0.3") });
    try {
      const reader = await noJs.newPage();
      await signInReader(reader, "ai");
      await reader.goto(`/t/${f.topicId}?lang=en&orig=${f.topicId}`);
      await expect(reader.getByRole("link", { name: en.open_in_ai_noscript, exact: true })).toHaveCount(1);
      const markdownScope = width >= await readingBreakpoint(reader) ? ".reading-toc-sidebar" : "[data-reading-byline]";
      await expect(reader.locator(markdownScope).getByRole("link", { name: en.open_in_ai_noscript, exact: true })).toHaveAttribute("href", `/t/${f.topicId}.md?lang=en`);
      await expect(reader.locator("#reply noscript, .reading-toc [aria-current]")).toHaveCount(0);
      // The list of languages is closed (a details) without JavaScript; its current link is still in the page.
      await expect(reader.locator('details.reading-lang-menu a[aria-current="page"]')).toHaveAttribute("lang", "en");
    } finally { await noJs.close(); }
  }
});
