import fs from "node:fs";
import ts from "typescript";
import { expect, it } from "vitest";
import { canonicalReadResource, READ_RESOURCE_QUERY_KEYS } from "~/lib/open-in-ai.server";

it("drops tracking and unknown values while retaining each resource's reader values", () => {
  for (const [resource, query] of [
    ["/t/7.md", "page=2&lang=fr&sentences=1&asks=1&long=1&order=created"],
    ["/latest.md", "page=2&lang=en&asks=1&long=1&order=activity"],
    ["/a/ja.txt", "lang=ja&order=insightful"],
    ["/following.md", "page=2&lang=ja&asks=1&all=1"],
    ["/search.md", "q=hello&lang=fr"],
    ["/changes.md", "since=2026-10-01&cursor=2026-10-01_7"],
    ["/glossary.md", "page=2&to=ja&from=en&deleted=1"],
    ["/manifest.json", "after=7"],
  ]) {
    const expected = canonicalReadResource(`${resource}?${query}`);
    expect(canonicalReadResource(`${resource}?utm_source=chatgpt.com&unknown=value&${query}&utm_medium=ai&k=opaque&o=inert`)).toBe(expected);
    for (const [key] of new URLSearchParams(query)) expect(new URL(expected!, "https://example.org").searchParams.has(key), key).toBe(true);
  }
  expect(canonicalReadResource("/t/7.txt?page=1&utm_source=chatgpt.com")).toBe("/t/7.md");
  expect(canonicalReadResource("/following.md?long=1&order=created")).toBe("/following.md?long=1&order=created");
  expect(canonicalReadResource("/glossary.md?lang=fr&q=unused")).toBe("/glossary.md");
  expect(canonicalReadResource("/glossary.yaml?to=fr&page=2")).toBe("/glossary.yaml");
  expect(canonicalReadResource("/t/7/stances.txt?lang=ja&page=2")).toBe("/t/7/stances.md");
});

it("binds following resources to every page reader query name", () => {
  expect(READ_RESOURCE_QUERY_KEYS.following).toEqual([...READ_RESOURCE_QUERY_KEYS.page, "all"]);
  for (const key of READ_RESOURCE_QUERY_KEYS.following) {
    const before = canonicalReadResource(`/following.md?${key}=first`);
    expect(canonicalReadResource(`/following.md?${key}=second`)).not.toBe(before);
  }
});

it("still rejects duplicate query names, including credentials, markers and ignored values", () => {
  for (const query of ["lang=en&lang=ja", "utm_source=a&utm_source=b", "unknown=1&unknown=2", "k=a&k=b", "o=a&o=b"]) expect(canonicalReadResource(`/t/7.md?${query}`)).toBeNull();
});

it("keeps every supported Markdown reader's query names in the scope inventory", () => {
  const sources = [
    ["app/lib/md/twin.server.ts", [...READ_RESOURCE_QUERY_KEYS.page, ...READ_RESOURCE_QUERY_KEYS.following]],
    ["app/routes/search-md.ts", READ_RESOURCE_QUERY_KEYS.search],
    ["app/routes/changes-md.ts", READ_RESOURCE_QUERY_KEYS.changes],
    ["app/routes/glossary-md.ts", READ_RESOURCE_QUERY_KEYS.glossary],
    ["app/routes/manifest.ts", READ_RESOURCE_QUERY_KEYS.manifest],
    ["app/routes/stances-md.ts", READ_RESOURCE_QUERY_KEYS.unfiltered],
    ["app/routes/glossary-export.ts", READ_RESOURCE_QUERY_KEYS.unfiltered],
  ] as const;
  for (const [path, names] of sources) {
    const source = ts.createSourceFile(path, fs.readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    const allowed = new Set<string>(names);
    const found = new Set<string>();
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ["get", "getAll", "has"].includes(node.expression.name.text)) {
        const receiver = node.expression.expression.getText(source);
        if (receiver === "params" || receiver === "query" || receiver.endsWith(".searchParams")) {
          const name = node.arguments[0];
          expect(name && ts.isStringLiteral(name), `${path}: query names must be declared explicitly`).toBe(true);
          if (name && ts.isStringLiteral(name)) { found.add(name.text); expect(allowed.has(name.text), `${path}: ${name.text} missing from scope inventory`).toBe(true); }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect([...found].sort(), path).toEqual([...allowed].sort());
  }
});

it("drops obsolete village paging and binds the all-post filter to its own resource", () => {
  expect(canonicalReadResource("/following.md?vpage=2")).toBe("/following.md");
  expect(canonicalReadResource("/following.md?all=1")).not.toBe(canonicalReadResource("/following.md"));
});
