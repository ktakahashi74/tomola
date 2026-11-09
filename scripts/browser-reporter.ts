import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type { FullConfig, FullResult, Reporter, TestCase, TestResult, TestError } from '@playwright/test/reporter';
import { metadataText, relativeTestFile } from './check-metadata.ts';
import { inputFingerprint, validationMetadata } from './check.mjs';

export default class BrowserReporter implements Reporter {
  private root = process.cwd();
  private mode = "private";
  private direct: Record<string, unknown> | undefined;
  private rows: Array<{file: string; line: number | null; title: string; status: string; retry: number; durationMs: number; quarantine: string | null}> = [];
  onBegin(config: FullConfig) {
    this.root = config.configFile ? path.dirname(config.configFile) : process.cwd();
    this.mode = config.metadata.publicReading ? "public" : path.basename(config.configFile ?? "") === "playwright.prod.config.ts" ? "production" : "private";
    // The check runner owns its pipeline record. Direct Playwright commands
    // still need provenance and a server choice in the usual latest record.
    if (!process.env.TOMOLA_BROWSER_REPORT) {
      const git = (args: string[]) => {
        const result = spawnSync("git", args, { cwd: this.root, encoding: "utf8" });
        if (result.status !== 0) throw new Error("Could not inspect direct browser inputs");
        return result.stdout.trim();
      };
      this.direct = { runId: randomUUID(), mode: "focused", standardMode: null, scope: "direct Playwright", commit: git(["rev-parse", "HEAD"]), dirty: Boolean(git(["status", "--porcelain"])), input: inputFingerprint(this.root), startedAt: new Date().toISOString(), status: "running", browserExecution: "serial", validation: validationMetadata(process.env), steps: [] };
      this.saveDirect();
      fs.appendFileSync(path.join(this.root, ".data/checks/history.jsonl"), JSON.stringify({ ...this.direct, event: "started" }) + "\n");
    }
  }
  private saveDirect() {
    fs.mkdirSync(path.join(this.root, ".data/checks"), { recursive: true });
    fs.writeFileSync(path.join(this.root, ".data/checks/latest.json"), JSON.stringify(this.direct, null, 2) + "\n");
  }
  onTestEnd(test: TestCase, result: TestResult) {
    let owner = test.parent;
    while (owner.type !== 'file' && owner.parent) owner = owner.parent;
    const sourceFile = owner.type === 'file' ? owner.location?.file ?? test.location.file : test.location.file;
    const quarantine = test.annotations.find(annotation => annotation.type === 'quarantine')?.description ?? null;
    this.rows.push({ file: relativeTestFile(this.root, sourceFile), line: test.location.file === sourceFile ? test.location.line : null, title: metadataText(test.titlePath().slice(1).join(' > '), this.root), status: result.status, retry: result.retry, durationMs: result.duration, quarantine: quarantine === null ? null : metadataText(quarantine, this.root) });
    if (quarantine && (result.retry || result.status !== 'passed' && result.status !== 'skipped')) console.log(`[quarantine] ${test.title}: ${result.status}, attempt ${result.retry + 1}/2 (${quarantine})`);
  }
  onError(error: TestError) { console.error(error.message); }
  onEnd(result: FullResult) {
    const destination = process.env.TOMOLA_BROWSER_REPORT ?? path.join(this.root, '.data/checks', `browser-results-${randomUUID()}.json`);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const server = this.mode === "production" ? "production" : process.env.E2E_SERVER === "build" ? "build" : "development";
    const evidence = { mode: this.mode, server, status: result.status, complete: process.env.TOMOLA_BROWSER_COMPLETE === "1" && result.status === "passed", tests: this.rows };
    fs.writeFileSync(destination, JSON.stringify(evidence, null, 2) + '\n');
    if (this.direct) {
      const stale = inputFingerprint(this.root) !== this.direct.input;
      const exitCode = stale ? 2 : result.status === "passed" ? 0 : 1;
      Object.assign(this.direct, { status: stale ? "stale" : exitCode ? "failed" : "passed", finishedAt: new Date().toISOString(), unrun: [], quarantineRecovered: 0,
        steps: [{ name: "direct browser", command: ["playwright", "test"], settings: { E2E_SERVER: server }, browserServer: server, durationMs: result.duration, exitCode, browser: evidence }],
      });
      this.saveDirect();
      fs.appendFileSync(path.join(this.root, ".data/checks/history.jsonl"), JSON.stringify(this.direct) + "\n");
    }
  }
}
