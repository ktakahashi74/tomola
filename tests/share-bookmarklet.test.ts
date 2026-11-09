import vm from "node:vm";
import { expect, it } from "vitest";
import { shareBookmarklet } from "~/lib/share-bookmarklet";

it("opens this site's posting screen with the current page, title and capped selection, without an opener", () => {
  const opened: { url: string; target: string; features: string }[] = [];
  const code = shareBookmarklet("https://tomola.example");
  expect(code).toMatch(/^javascript:/);
  vm.runInNewContext(code.slice("javascript:".length), {
    URL, location: { href: "https://example.org/a?q=1&b=2" }, document: { title: "A [title] 日本語" },
    getSelection: () => ` ${"x".repeat(1001)} `,
    window: { open: (url: URL, target: string, features: string) => opened.push({ url: String(url), target, features }) },
  });
  expect(opened).toHaveLength(1);
  const url = new URL(opened[0].url);
  expect(`${url.origin}${url.pathname}`).toBe("https://tomola.example/t/new");
  expect(url.searchParams.get("url")).toBe("https://example.org/a?q=1&b=2");
  expect(url.searchParams.get("title")).toBe("A [title] 日本語");
  expect(url.searchParams.get("text")).toBe("x".repeat(1000));
  expect(opened[0]).toMatchObject({ target: "_blank", features: "noopener" });
});

it("omits an empty selection and quotes a configured site URL safely inside JavaScript", () => {
  let destination: URL | undefined;
  vm.runInNewContext(shareBookmarklet("https://tomola.example/o'connor").slice("javascript:".length), {
    URL, location: { href: "https://example.org/" }, document: { title: "Example" }, getSelection: () => "  ",
    window: { open: (url: URL) => { destination = url; } },
  });
  expect(destination?.pathname).toBe("/o'connor/t/new");
  expect(destination?.searchParams.has("text")).toBe(false);
});
