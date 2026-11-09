import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkNotices } from "../scripts/third-party-notices";

// Existing publication and deployment requirements, separated from DB fixtures.
const root = path.resolve(import.meta.dirname, "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const REAL = path.join(root, "docs/drafts/glossary-initial.yaml");
const names = /\b(zh-CN|zh-TW|zh-HK|zh_CN|zh_TW)\b|台湾語|台湾中国語|中国大陸の中国語|中国大陸語|Taiwanese Chinese|Mainland Chinese/;

it("is documented in docs/deploy.md and .env.example", () => {
    expect(read("docs/deploy.md")).toContain("`SOURCE_URL`");
    expect(read(".env.example")).toContain("SOURCE_URL=");
  });

describe("documented development and deployment entry points", () => {
  it("uses commands and local links that exist", () => {
    const scripts = JSON.parse(read("package.json")).scripts as Record<string, string>;
    const builtins = new Set(["install", "audit", "outdated", "add", "remove", "exec"]);
    let commands = 0, links = 0;
    for (const document of ["docs/deploy.md", "docs/development.md", "README.md"]) {
      const text = read(document);
      const commandsText = [...text.matchAll(/```[^\n]*\n([\s\S]*?)```|`([^`\n]+)`/g)].map(match => match[1] ?? match[2]).join("\n").replace(/^\s*#.*$/gm, "");
      for (const match of commandsText.matchAll(/\bpnpm (?!exec\b)([\w:.-]+)/g)) {
        expect(Boolean(scripts[match[1]]) || builtins.has(match[1]), `${document}: pnpm ${match[1]}`).toBe(true);
        commands++;
      }
      for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
        const target = match[1].split("#")[0];
        if (!target || /^(?:[a-z]+:|\/)/i.test(target)) continue;
        expect(fs.existsSync(path.resolve(root, path.dirname(document), decodeURIComponent(target))), `${document}: ${target}`).toBe(true);
        links++;
      }
    }
    expect(commands).toBeGreaterThan(5);
    expect(links).toBeGreaterThan(0);
  });
});

describe("the image has the initial glossary for docker compose exec app pnpm glossary:import", () => {
  const lines = (file: string) => fs.readFileSync(path.join(root, file), "utf8").split("\n").map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#"));

  it("re-includes docs/drafts/glossary-initial.yaml in the build context, parent directories first, and copies it into the runtime image at the path deploy.md uses", () => {
    const ignore = lines(".dockerignore");
    // Exclude docs, then re-include this file through its parents in order; later rules override earlier ones.
    const at = (pattern: string) => ignore.indexOf(pattern);
    expect(ignore).not.toContain("docs");
    expect(at("docs/*")).toBeGreaterThanOrEqual(0);
    expect(at("!docs/drafts")).toBeGreaterThan(at("docs/*"));
    expect(at("docs/drafts/*")).toBeGreaterThan(at("!docs/drafts"));
    expect(at("!docs/drafts/glossary-initial.yaml")).toBeGreaterThan(at("docs/drafts/*"));
    const dockerfile = lines("Dockerfile");
    expect(dockerfile).toContain("COPY docs/drafts/glossary-initial.yaml ./docs/drafts/glossary-initial.yaml");
    // deploy.md uses this path relative to /app.
    expect(dockerfile).toContain("WORKDIR /app");
    expect(fs.readFileSync(path.join(root, "docs/deploy.md"), "utf8")).toContain("docker compose exec app pnpm glossary:import docs/drafts/glossary-initial.yaml --as <handle> --dry-run");
    expect(fs.existsSync(REAL)).toBe(true);
  });

  it("ships the evaluation cases needed by the container's operator command", () => {
    const runtime = read("Dockerfile").split(/^FROM /m).at(-1)!;
    expect(runtime).toContain("COPY eval ./eval");
    expect(lines(".dockerignore")).not.toContain("eval");
    expect(fs.existsSync(path.join(root, "eval/translation/cases.yaml"))).toBe(true);
    expect(read("docs/development.md")).toContain("docker compose exec app pnpm eval:translate --estimate");
  });
});

it("does not appear in docs/deploy.md as the name of a language", () => {
    expect(fs.readFileSync(path.join(root, "docs/deploy.md"), "utf8")).not.toMatch(names);
  });

it("has no agibook in the public README", () => {
  expect(read("README.md")).not.toMatch(/agibook/i);
});

it("keeps generated production dependency notices current", () => checkNotices(root));
