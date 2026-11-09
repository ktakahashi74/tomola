import { expect, test } from "vitest";
import { calculateRouteSizes, type BundleManifest } from "../scripts/bundle-size";
import { collectStaticScripts, pageGzipLimit, READING_PAGE_GZIP_LIMIT, WRITING_PAGE_GZIP_LIMIT } from "../scripts/editor-bundle-budget";

test("page budgets include entry and ancestors, deduplicate shared scripts and exclude resource routes", () => {
  const manifest: BundleManifest = {
    entry: { module: "entry.js", imports: ["shared.js", "entry.js"] },
    routes: {
      root: { id: "root", module: "root.js", imports: ["shared.js"] },
      layout: { id: "layout", parentId: "root", module: "layout.js", imports: ["layout-import.js", "shared.js"] },
      page: { id: "page", parentId: "layout", module: "page.js", imports: ["layout-import.js", "page.js"], hasDefaultExport: true },
      sibling: { id: "sibling", parentId: "root", module: "sibling.js", hasDefaultExport: true },
      resource: { id: "resource", parentId: "root", module: "resource.js", hasDefaultExport: false },
    },
  };
  const sizes = { "entry.js": 10, "shared.js": 20, "root.js": 30, "layout.js": 40, "layout-import.js": 50, "page.js": 60, "sibling.js": 0 };
  expect(calculateRouteSizes(manifest, sizes)).toEqual([
    { routeId: "page", gzipBytes: 210 },
    { routeId: "sibling", gzipBytes: 60 },
  ]);
  expect(() => calculateRouteSizes(manifest, { ...sizes, "shared.js": NaN })).toThrow("Missing or invalid gzip size");
  const { "shared.js": _shared, ...incomplete } = sizes;
  expect(() => calculateRouteSizes(manifest, incomplete)).toThrow("Missing or invalid gzip size");
  expect(() => calculateRouteSizes({ ...manifest, routes: { ...manifest.routes, root: { ...manifest.routes.root, parentId: "missing" } } }, sizes)).toThrow("Missing parent route");
  expect(() => calculateRouteSizes({ ...manifest, routes: { ...manifest.routes, root: { ...manifest.routes.root, parentId: "page" } } }, sizes)).toThrow("Cyclic route ancestry");
});

test("only the two writing routes receive the editor budget", () => {
  for (const id of ["routes/topic-new", "routes/topic-edit"]) expect(pageGzipLimit(id)).toBe(WRITING_PAGE_GZIP_LIMIT);
  for (const id of ["routes/topic", "routes/reply-edit", "routes/draft", "routes/home", "routes/principles"]) expect(pageGzipLimit(id)).toBe(READING_PAGE_GZIP_LIMIT);
});

test("lazy editor imports are followed and shared initial files counted only once", () => {
  const files: Record<string, string> = {
    "/assets/editor.js": 'import{a}from"./shared.js";import "./kit.js";import("./optional.js")',
    "/assets/shared.js": 'import{b}from"./kit.js";',
    "/assets/kit.js": 'import{c}from"./shared.js";',
  };
  const scripts = collectStaticScripts("/assets/editor.js", file => files[file]);
  expect([...scripts]).toEqual(["/assets/editor.js", "/assets/shared.js", "/assets/kit.js"]);
  expect(() => collectStaticScripts("/assets/../secret.js", file => files[file])).toThrow("Unexpected editor script path");
  const manifest: BundleManifest = { entry: { module: "/assets/shared.js" }, routes: {
    "routes/topic-new": { id: "routes/topic-new", module: "/assets/new.js", hasDefaultExport: true },
    "routes/topic": { id: "routes/topic", module: "/assets/topic.js", hasDefaultExport: true },
  } };
  const sizes = { "/assets/shared.js": 10, "/assets/new.js": 20, "/assets/topic.js": 30, "/assets/editor.js": 40, "/assets/kit.js": 50 };
  expect(calculateRouteSizes(manifest, sizes, { "routes/topic-new": [...scripts] })).toEqual([
    { routeId: "routes/topic-new", gzipBytes: 120 }, { routeId: "routes/topic", gzipBytes: 40 },
  ]);
});
