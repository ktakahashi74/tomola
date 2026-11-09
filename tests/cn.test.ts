import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { cn as originalCn } from "cn";
import { expandGlobs, extractTokens } from "cn/build";
import { cn } from "~/lib/utils";
import { cnBuildOptions } from "../scripts/cn-build";

it("preserves merge results for source classes and their conflicting overrides", () => {
  const tokens = new Set<string>();
  for (const file of expandGlobs(cnBuildOptions.content, process.cwd())) extractTokens(fs.readFileSync(file, "utf8"), tokens);
  // Recognized classes merge with themselves; ordinary source words do not.
  const classes: string[] = [];
  for (const token of tokens) {
    const merged = originalCn(token, token);
    expect(cn(token, token), token).toBe(merged);
    if (merged === token) classes.push(token);
  }
  expect(classes.length).toBeGreaterThan(100);
  const families = new Map<string, string[]>();
  for (const token of classes) {
    const key = token.split(":").at(-1)!.replace(/^-/, "").split("-")[0];
    const family = families.get(key) ?? [];
    family.push(token);
    families.set(key, family);
  }
  for (const family of families.values()) {
    for (let index = 0; index < family.length; index++) {
      const first = family[index], second = family[(index * 31 + 7) % family.length];
      for (const inputs of [[first, second], [second, first], [[first, false], { [second]: true }]]) {
        expect(cn(...inputs), JSON.stringify(inputs)).toBe(originalCn(...inputs));
      }
    }
  }
});

it("routes every app import through the generated merger", () => {
  for (const file of expandGlobs(["app/**/*.{ts,tsx,js,jsx}"], process.cwd())) {
    expect(fs.readFileSync(file, "utf8"), path.relative(process.cwd(), file)).not.toMatch(/from\s*["']cn["']/);
  }
});
