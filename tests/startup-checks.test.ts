import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertStartupConfig as startupConfig } from "~/lib/startup-checks.server";
import { resolveEngines } from "~/lib/llm/config.server";
import { createFigureReader } from "~/lib/figure-reading.server";

// Production startup also checks the review counts of the UI strings that the build embeds (a test worktree has none): hand it a clean ja/en.
const CLEAN_COUNTS = { ja: { unverified: 0, unverifiedPublic: 0, missing: 0, stale: 0 }, en: { unverified: 0, unverifiedPublic: 0, missing: 0, stale: 0 } };
const assertStartupConfig = (env: Record<string, string | undefined>, log?: (message: string) => void) => startupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...env }, log, { reviewCounts: CLEAN_COUNTS });

it("validates the village suggestion switch and enabled model before accepting requests", () => {
  const env = { NODE_ENV: "test", TRANSLATION_PRIMARY: "fake", EMBEDDING_ENGINE: "fake" };
  for (const VILLAGE_SLUG_SUGGEST of [undefined, "", "0", "1"]) {
    expect(() => assertStartupConfig({ ...env, VILLAGE_SLUG_SUGGEST })).not.toThrow();
  }
  for (const VILLAGE_SLUG_SUGGEST of ["true", "false", "2", " 1 "]) {
    expect(() => assertStartupConfig({ ...env, VILLAGE_SLUG_SUGGEST })).toThrow("VILLAGE_SLUG_SUGGEST");
  }
  for (const TRANSLATION_PRIMARY of ["gemini", "claude"]) {
    const wrongModel = TRANSLATION_PRIMARY === "gemini" ? "claude-haiku-4-5" : "gemini-3.5-flash-lite";
    for (const VILLAGE_SLUG_SUGGEST_MODEL of ["invalid/model", wrongModel]) {
      expect(() => assertStartupConfig({ ...env, TRANSLATION_PRIMARY, VILLAGE_SLUG_SUGGEST: "1", VILLAGE_SLUG_SUGGEST_MODEL })).toThrow("VILLAGE_SLUG_SUGGEST_MODEL");
      expect(() => assertStartupConfig({ ...env, TRANSLATION_PRIMARY, VILLAGE_SLUG_SUGGEST: "0", VILLAGE_SLUG_SUGGEST_MODEL })).not.toThrow();
    }
  }
});

it("refuses missing and example operator settings at the server startup gate", () => {
  expect(() => assertStartupConfig({ NODE_ENV: "test", TOMOLA_OPERATOR_DIR: undefined })).toThrow("TOMOLA_OPERATOR_DIR is required");
  expect(() => assertStartupConfig({ NODE_ENV: "test", TOMOLA_OPERATOR_DIR: path.resolve("deploy/operator.example") })).toThrow("status");
  expect(() => assertStartupConfig({ NODE_ENV: "test" })).not.toThrow();
});

it("rejects a misspelled site stage before startup and accepts test or unset", () => {
  for (const TOMOLA_SITE_STAGE of [undefined, "", "test"]) expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, NODE_ENV: "development", TOMOLA_SITE_STAGE })).not.toThrow();
  expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, NODE_ENV: "development", TOMOLA_SITE_STAGE: "tset" })).toThrow("TOMOLA_SITE_STAGE");
});

it("accepts operator-only invitations when enabled or empty and rejects other values at startup", () => {
  for (const OPERATOR_ONLY_INVITATIONS of [undefined, "", " ", "1", " 1 "]) {
    expect(() => assertStartupConfig({ NODE_ENV: "development", OPERATOR_ONLY_INVITATIONS })).not.toThrow();
  }
  for (const OPERATOR_ONLY_INVITATIONS of ["0", "true", "false", "yes", "2"]) {
    expect(() => assertStartupConfig({ NODE_ENV: "development", OPERATOR_ONLY_INVITATIONS })).toThrow("OPERATOR_ONLY_INVITATIONS");
  }
});

it("checks configuration without importing a database client or initializing workers", async () => {
  vi.resetModules();
  vi.doMock("~/lib/db/client.server", () => { throw new Error("database client imported before the startup gate"); });
  vi.doMock("~/lib/jobs/worker.server", () => { throw new Error("worker imported before the startup gate"); });
  try {
    const { assertStartupConfig: check } = await import("~/lib/startup-checks.server");
    expect(() => check({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, NODE_ENV: "development", ENABLED_LANGS: "ja,unknown" })).toThrow("unknown language tag");
  } finally {
    vi.doUnmock("~/lib/db/client.server");
    vi.doUnmock("~/lib/jobs/worker.server");
    vi.resetModules();
  }
});

it("runs the pre-migration gate from runtime files without messages, database drivers or workers, and rejects old or incomplete counts", { timeout: 60_000 }, () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "startup-image-"));
  try {
    fs.cpSync(path.join(process.cwd(), "app", "lib"), path.join(dir, "app", "lib"), { recursive: true });
    fs.rmSync(path.join(dir, "app", "lib", "db", "client.server.ts"));
    fs.rmSync(path.join(dir, "app", "lib", "jobs", "worker.server.ts"));
    fs.mkdirSync(path.join(dir, "scripts"));
    fs.copyFileSync(path.join(process.cwd(), "scripts", "check-startup.ts"), path.join(dir, "scripts", "check-startup.ts"));
    fs.copyFileSync(path.join(process.cwd(), "tsconfig.json"), path.join(dir, "tsconfig.json"));
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ type: "module" }));
    fs.symlinkSync(path.join(process.cwd(), "node_modules"), path.join(dir, "node_modules"));
    const countsFile = path.join(dir, "app", "lib", "i18n", "review-counts.generated.json");
    const check = (overrides: NodeJS.ProcessEnv = {}) => spawnSync(path.join(process.cwd(), "node_modules", ".bin", "tsx"), ["scripts/check-startup.ts"], {
      cwd: dir,
      env: {
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
        NODE_ENV: "production",
        TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR,
        ENABLED_LANGS: "ja,en",
        BETTER_AUTH_SECRET: "x".repeat(32),
        BETTER_AUTH_URL: "https://forum.example.org",
        SMTP_URL: "smtp://localhost:2525",
        MAIL_FROM: "tomola <no-reply@example.org>",
        MAIL_DECOY_TO: "test@blackhole.postmarkapp.com",
        DATABASE_URL: "postgres://unreachable.invalid/tomola",
        GEMINI_API_KEY: "",
        ANTHROPIC_API_KEY: "",
        TRANSLATION_PRIMARY: "fake",
        EMBEDDING_ENGINE: "fake",
        TOMOLA_ALLOW_FAKE_ENGINES: "1",
        ...overrides,
      },
      encoding: "utf8",
    });
    fs.rmSync(countsFile, { force: true });
    expect(check().stderr).toContain("did not embed the review counts");
    fs.writeFileSync(countsFile, JSON.stringify({ ja: { unverified: 0 }, en: { unverified: 0 } }));
    const old = check();
    expect(old.status).toBe(1);
    expect(old.stderr).toContain("did not embed the review counts");
    fs.writeFileSync(countsFile, JSON.stringify({ ...CLEAN_COUNTS, ja: { ...CLEAN_COUNTS.ja, missing: 1 } }));
    const missing = check();
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("ja: 1 missing and 0 stale");
    fs.writeFileSync(countsFile, JSON.stringify(CLEAN_COUNTS));
    const ready = check();
    expect(ready.status, ready.stderr).toBe(0);
    const fontBin = path.join(dir, "font-bin"), fontDir = path.join(dir, "fonts");
    fs.mkdirSync(fontBin); fs.mkdirSync(fontDir);
    fs.symlinkSync(process.execPath, path.join(fontBin, "node"));
    // Isolate fontconfig from the host. A disabled feature needs no probe;
    // enabled preflight rejects both failed probes and unreadable font files.
    const fontEnv = { PATH: fontBin, FONT_TEST_DIRECTORY: fontDir };
    expect(check({ ...fontEnv, FIGURE_TRANSLATION: "0" }).status).toBe(0);
    expect(check({ ...fontEnv, FIGURE_TRANSLATION: "1" }).status).toBe(1);
    fs.writeFileSync(path.join(fontBin, "fc-match"), `#!/bin/sh
family="\${3%:weight=*}"
weight="\${3##*:weight=}"
case "$family" in
  "Noto Sans") face=NotoSans-Regular.ttf ;;
  "Noto Sans Thai") face=NotoSansThai-Regular.ttf ;;
  "Noto Sans CJK JP"|"Noto Sans CJK KR"|"Noto Sans CJK SC"|"Noto Sans CJK TC") face=NotoSansCJK-Regular.ttc ;;
  *) exit 1 ;;
esac
if [ "$weight" = "bold" ]; then
  case "$family" in
    "Noto Sans") face=NotoSans-Bold.ttf ;;
    "Noto Sans Thai") face=NotoSansThai-Bold.ttf ;;
    *) face=NotoSansCJK-Bold.ttc ;;
  esac
fi
if [ "$family" = "$FONT_TEST_FALLBACK_FAMILY" ]; then face=NotoSans-Regular.ttf; fi
printf '%s\\n%s/%s\\n20-7e\\n' "$family" "$FONT_TEST_DIRECTORY" "$face"
`, { mode: 0o755 });
    expect(check({ ...fontEnv, FIGURE_TRANSLATION: "1" }).status).toBe(1);
    for (const file of ["NotoSans-Regular.ttf", "NotoSansThai-Regular.ttf", "NotoSansCJK-Regular.ttc"]) fs.writeFileSync(path.join(fontDir, file), "font probe fixture");
    const regularOnly = check({ ...fontEnv, FIGURE_TRANSLATION: "1" });
    expect(regularOnly.status, regularOnly.stderr).toBe(1);
    expect(regularOnly.stderr).toContain("bold");
    for (const file of ["NotoSans-Bold.ttf", "NotoSansThai-Bold.ttf", "NotoSansCJK-Bold.ttc"]) fs.writeFileSync(path.join(fontDir, file), "font probe fixture");
    const withFonts = check({ ...fontEnv, FIGURE_TRANSLATION: "1" });
    expect(withFonts.status, withFonts.stderr).toBe(0);
    for (const file of ["NotoSans-Bold.ttf", "NotoSansThai-Bold.ttf", "NotoSansCJK-Bold.ttc"]) {
      fs.unlinkSync(path.join(fontDir, file));
      const missing = check({ ...fontEnv, FIGURE_TRANSLATION: "1" });
      expect(missing.status, `${file}: ${missing.stderr}`).toBe(1);
      expect(missing.stderr).toContain("bold");
      fs.writeFileSync(path.join(fontDir, file), "font probe fixture");
    }
    for (const family of ["Noto Sans CJK KR", "Noto Sans CJK SC", "Noto Sans CJK TC"]) {
      const fallback = check({ ...fontEnv, FIGURE_TRANSLATION: "1", FONT_TEST_FALLBACK_FAMILY: family });
      expect(fallback.status, fallback.stderr).toBe(1);
      expect(fallback.stderr).toContain(`Figure font unavailable: ${family}`);
    }
    expect(fs.existsSync(path.join(dir, "messages"))).toBe(false);
    expect(fs.existsSync(path.join(dir, ".data"))).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


const good = {
  NODE_ENV: "production",
  BETTER_AUTH_SECRET: "x".repeat(32),
  BETTER_AUTH_URL: "https://forum.example.org",
  SMTP_URL: "smtps://user:pw@smtp.example.org:465",
  MAIL_FROM: "tomola <no-reply@example.org>",
  MAIL_DECOY_TO: "test@blackhole.postmarkapp.com",
  // Production must set ENABLED_LANGS explicitly (see tests/enabled-langs.test.ts).
  ENABLED_LANGS: "ja,en",
  // Production must not start with fake engines; without keys, both translation and embedding default to fake.
  GEMINI_API_KEY: "test-key-not-used",
  // Production requires PostgreSQL or explicitly configured PGlite to start.
  DATABASE_URL: "postgres://tomola:pw@db:5432/tomola",
};

describe("the startup check in production", () => {
  it.each([undefined, "gemini-3.8-flash"])("starts with distinct Gemini comparison models when the primary override is %s", primaryModel => {
    const env = {
      ...good, TOMOLA_SITE_STAGE: "test", TRANSLATION_PRIMARY: "gemini",
      TRANSLATION_GEMINI_MODEL: primaryModel,
      VILLAGES: "1", VILLAGE_CHAT: "1", FIGURE_TRANSLATION: "1",
      ...(primaryModel ? { FIGURE_READING_MODEL: "gemini-3.5-flash-lite" } : {}),
    };
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...env }, vi.fn())).not.toThrow();
    expect(resolveEngines(env)).toMatchObject({ secondary: null, judge: null });
    const comparison = { ...env, TRANSLATION_SECONDARY: "gemini", DIVERGENCE_JUDGE: "gemini" };
    expect(() => assertStartupConfig(comparison, vi.fn())).not.toThrow();
    const engines = resolveEngines(comparison);
    expect(engines.primary.model).toBe(primaryModel ?? "gemini-3.5-flash-lite");
    expect(engines.secondary?.model).toBe("gemini-3.6-flash");
    expect(engines.judge?.model).toBe("gemini-3.6-flash");
    expect(engines.secondary?.model).not.toBe(engines.primary.model);
    expect(engines.judge?.model).not.toBe(engines.primary.model);
    expect(engines.chat?.model).toBe("gemini-3.5-flash-lite");
    expect(createFigureReader(env).model).toBe("gemini-3.5-flash-lite");
  });
  it.each(["-1", "NaN", "Infinity", "1e9", "999999999999999999999"])("rejects an invalid public LLM budget: %s", value => {
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...good, LLM_MONTHLY_BUDGET_USD: value })).toThrow(/LLM_MONTHLY_BUDGET_USD/);
  });
  it.each(["0", "9", "1.5", "bad"])("rejects an invalid translation concurrency: %s", value => {
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...good, TRANSLATION_CONCURRENCY: value })).toThrow(/TRANSLATION_CONCURRENCY/);
  });
  it("passes with a complete configuration", () => {
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...good })).not.toThrow();
  });

  it("refuses to start without a sending configuration", () => {
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...good, SMTP_URL: undefined })).toThrow("SMTP_URL and MAIL_FROM are required");
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...good, MAIL_FROM: undefined })).toThrow("MAIL_FROM is required");
  });

  it("refuses to start without a secret, or with a short one", () => {
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...good, BETTER_AUTH_SECRET: undefined })).toThrow("BETTER_AUTH_SECRET is required");
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...good, BETTER_AUTH_SECRET: "   " })).toThrow("BETTER_AUTH_SECRET is required");
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...good, BETTER_AUTH_SECRET: "x".repeat(31) })).toThrow("at least 32 characters");
  });

  it("refuses to start without a site URL, with one that is not a URL, or with one that is not https", () => {
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...good, BETTER_AUTH_URL: undefined })).toThrow("BETTER_AUTH_URL is required");
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...good, BETTER_AUTH_URL: "forum.example.org" })).toThrow("not a valid URL");
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...good, BETTER_AUTH_URL: "http://forum.example.org" })).toThrow("https://");
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...good, BETTER_AUTH_URL: "http://localhost:5173" })).toThrow("https://");
  });

  it("requires ENABLED_LANGS, and refuses a language whose interface strings the build does not report as checked", () => {
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...good, ENABLED_LANGS: undefined })).toThrow("ENABLED_LANGS is required in production");
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...good, ENABLED_LANGS: "ja,xx" })).toThrow("unknown language tag");
    // the counts handed to startup only know ja and en
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...good, ENABLED_LANGS: "ja,en,fr" })).toThrow("fr: no review counts in the build");
    // and without counts at all (the build step was skipped) production does not start
    expect(() => startupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...good, ENABLED_LANGS: "ja,en" }, undefined, { reviewCounts: null })).toThrow("did not embed the review counts");
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...good, ENABLED_LANGS: "en" })).not.toThrow();
  });

  it("treats an unset NODE_ENV as production, and checks TRUSTED_PROXY_HOPS", () => {
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...good, NODE_ENV: undefined, BETTER_AUTH_SECRET: undefined })).toThrow("BETTER_AUTH_SECRET is required");
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...good, TRUSTED_PROXY_HOPS: "abc" })).toThrow("TRUSTED_PROXY_HOPS");
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...good, TRUSTED_PROXY_HOPS: "1" })).not.toThrow();
  });

  it("refuses to start when the translation or embedding engine would be the fake engine, unless TOMOLA_ALLOW_FAKE_ENGINES=1", () => {
    // Without keys, both translation and embedding default to fake.
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...good, GEMINI_API_KEY: undefined })).toThrow(/Refusing to start in production.*primary translation engine.*embedding engine/s);
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...good, GEMINI_API_KEY: "" })).toThrow("fake engine");
    // Explicit fake configuration behaves the same way.
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...good, TRANSLATION_PRIMARY: "fake" })).toThrow("primary translation engine");
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...good, EMBEDDING_ENGINE: "fake" })).toThrow(/embedding engine \(EMBEDDING_ENGINE\)/);
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...good, TRANSLATION_SECONDARY: "fake" })).toThrow("secondary translation engine");
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...good, DIVERGENCE_JUDGE: "fake" })).toThrow("divergence judge");
    // none for the secondary lineage and judge is not fake; even with only a Gemini key, the default is another Gemini model.
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...good, TRANSLATION_SECONDARY: "none", DIVERGENCE_JUDGE: "none" })).not.toThrow();
    // An explicit real engine without its key throws a configuration error at startup.
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...good, ANTHROPIC_API_KEY: undefined, TRANSLATION_SECONDARY: "claude" })).toThrow("ANTHROPIC_API_KEY");
    // Explicit opt-in for a test environment; only 1 is accepted.
    const fakes = { ...good, GEMINI_API_KEY: undefined };
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...fakes, TOMOLA_ALLOW_FAKE_ENGINES: "1" })).not.toThrow();
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...fakes, TOMOLA_ALLOW_FAKE_ENGINES: "true" })).toThrow("fake engine");
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...fakes, TOMOLA_ALLOW_FAKE_ENGINES: "0" })).toThrow("fake engine");
  });

  it("checks GEMINI_TRANSLATION_THINKING and DIVERGENCE_JUDGE_THINKING at the start, even with TOMOLA_ALLOW_FAKE_ENGINES=1 and when no Gemini engine is built", () => {
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...good, GEMINI_TRANSLATION_THINKING: "low", DIVERGENCE_JUDGE_THINKING: "default" })).not.toThrow();
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...good, GEMINI_TRANSLATION_THINKING: "hgh" })).toThrow('GEMINI_TRANSLATION_THINKING must be one of: off, low, default (got "hgh")');
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...good, DIVERGENCE_JUDGE_THINKING: "max" })).toThrow("DIVERGENCE_JUDGE_THINKING must be one of: off, low, default");
    const fakes = { ...good, GEMINI_API_KEY: undefined, TOMOLA_ALLOW_FAKE_ENGINES: "1" };
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...fakes, GEMINI_TRANSLATION_THINKING: "hgh" })).toThrow("GEMINI_TRANSLATION_THINKING must be one of");
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...fakes, TRANSLATION_PRIMARY: "claude", ANTHROPIC_API_KEY: "k", DIVERGENCE_JUDGE_THINKING: "max" })).toThrow("DIVERGENCE_JUDGE_THINKING must be one of");
  });

  it("refuses to start on PGlite unless PGLITE_DATA_DIR is set explicitly: a missing DATABASE_URL must not turn the server into a development database", () => {
    // Without DATABASE_URL, refuse to start with the default ./.data/pglite.
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...good, DATABASE_URL: undefined })).toThrow(/DATABASE_URL \(postgres:\/\/…\) is required in production/);
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...good, DATABASE_URL: "   " })).toThrow("is required in production");
    // postgres:// and postgresql:// pass unchanged.
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...good, DATABASE_URL: "postgresql://u:p@h:5432/d" })).not.toThrow();
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...good, DATABASE_URL: "POSTGRES://u:p@h/d" })).not.toThrow();
    // PGlite requires explicit PGLITE_DATA_DIR without DATABASE_URL.
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...good, DATABASE_URL: undefined, PGLITE_DATA_DIR: "/var/lib/tomola" })).not.toThrow();
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...good, DATABASE_URL: undefined, PGLITE_DATA_DIR: "  " })).toThrow("is required in production");
    // Reject the legacy path-in-DATABASE_URL form whether or not PGLITE_DATA_DIR exists; a mistyped postgres:// must not silently select PGlite.
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...good, DATABASE_URL: "/var/lib/tomola" })).toThrow(/must be a postgres/);
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...good, DATABASE_URL: "postgre://u:p@h/d" })).toThrow(/must be a postgres/);
    // When PostgreSQL is configured, ignore PGLITE_DATA_DIR.
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...good, PGLITE_DATA_DIR: "/x" })).not.toThrow();
  });

  it("does not look at the engines in development and test", () => {
    for (const NODE_ENV of ["development", "test"]) expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, NODE_ENV })).not.toThrow();
  });

  it("does not ask for a database URL in development and test (PGlite is the development database)", () => {
    for (const NODE_ENV of ["development", "test"]) expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, NODE_ENV, DATABASE_URL: "/some/path" })).not.toThrow();
  });

  it("does not ask for any of it in development and test", () => {
    for (const NODE_ENV of ["development", "test"]) expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, NODE_ENV })).not.toThrow();
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, NODE_ENV: "development", TRUSTED_PROXY_HOPS: "abc" })).toThrow("TRUSTED_PROXY_HOPS");
  });
});

describe("the startup module the server loads", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    vi.resetModules();
  });

  it("throws on import in production with a missing secret, a non-https URL or no mail configuration (this is what stops the server)", async () => {
    const env = process.env as Record<string, string | undefined>;
    const setProduction = (overrides: Record<string, string | undefined>) => {
      Object.assign(env, good, overrides);
      for (const [k, v] of Object.entries(overrides)) if (v === undefined) delete env[k];
    };
    for (const overrides of [{ BETTER_AUTH_SECRET: undefined }, { BETTER_AUTH_URL: "http://forum.example.org" }, { SMTP_URL: undefined }]) {
      vi.resetModules();
      setProduction(overrides);
      await expect(import("~/lib/startup.server"), JSON.stringify(overrides)).rejects.toThrow();
    }
    vi.resetModules();
    setProduction({});
    // The full configuration also passes the review-counts check of the UI strings, which reads the file that the build embeds. A clean checkout has no such file, so give the
    // freshly imported modules a clean ja/en (vi.doMock reaches modules imported after it, unlike vi.mock for modules that a setup file already imported).
    vi.doMock("~/lib/i18n/review-counts.server", () => ({ REVIEW_COUNTS_FILE: "review-counts.generated.json", loadReviewCounts: () => CLEAN_COUNTS }));
    try {
      await expect(import("~/lib/startup.server")).resolves.toBeDefined();
    } finally {
      vi.doUnmock("~/lib/i18n/review-counts.server");
    }
  });
});
