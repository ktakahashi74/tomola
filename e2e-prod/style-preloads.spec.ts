import { test, expect, useMember } from "./helpers";

test.use({ serviceWorkers: "block" });

test("production documents hint exactly their head styles without exposing reader data", async ({ page, baseURL }) => {
  const checkDocument = async (route: string) => {
    const response = await page.request.get(`${baseURL}${route}`);
    expect(response.status()).toBe(200);
    const html = await response.text();
    const head = html.slice(0, html.indexOf("</head>"));
    const css = [...head.matchAll(/<link\b[^>]*>/g)].map(match => match[0])
      .filter(link => /\brel="stylesheet"/.test(link)).map(link => link.match(/\bhref="([^"]+)"/)![1]);
    expect(response.headers().link, route).toBeDefined();
    const hints = response.headers().link.split(/,\s*/).map(link => {
      const match = /^<([^>]+)>; rel=preload; as=style$/.exec(link);
      expect(match).toBeTruthy();
      expect(match![1]).toMatch(/^\/assets\/[A-Za-z0-9_./-]+\.css$/);
      return match![1];
    });
    expect(hints.sort()).toEqual([...new Set(css)].sort());
    expect(response.headers()["cache-control"]).toContain("private");
    return hints;
  };
  const initial = await checkDocument("/principles");
  const head = await page.request.head(`${baseURL}/principles`);
  expect(head.status()).toBe(200);
  expect(head.headers().link.split(/,\s*/).sort()).toEqual(initial.map(href => `<${href}>; rel=preload; as=style`).sort());
  expect(await checkDocument("/principles?lang=en&reader=private-value")).toEqual(initial);
  await checkDocument("/why");
  await checkDocument("/name");
  await checkDocument("/login");
  await useMember(page, "style_preloads_reader@example.com");
  const created = await page.request.post(`${baseURL}/t/new`, { headers: { origin: baseURL! }, form: { lang: "en", title: "Resource hints for math", body: "An equation: $x^2$." }, maxRedirects: 0 });
  expect(created.status()).toBe(302);
  const topic = new URL(created.headers().location, baseURL).pathname;
  await checkDocument(topic);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (/Content Security Policy|Refused to/i.test(message.text())) errors.push(message.text()); });
  await page.goto(topic);
  await expect(page.locator(".katex")).toBeVisible();
  expect(errors).toEqual([]);
  for (const route of ["/principles.md", "/principles.data", "/api/openapi.json", "/manifest.webmanifest", "/no-such-page", `${topic}.md`, initial[0]]) {
    const response = await page.request.get(`${baseURL}${route}`);
    expect(response.headers().link, route).toBeUndefined();
  }
});
