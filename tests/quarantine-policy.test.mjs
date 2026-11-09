import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
test('only annotated browser cases retry once and every attempt is recorded', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quarantine-policy-'));
  const output = path.join(directory, 'results.json');
  try {
    const quarantine = fileURLToPath(new URL('../e2e/quarantine.ts', import.meta.url));
    const reporter = fileURLToPath(new URL('../scripts/browser-reporter.ts', import.meta.url));
    const playwright = fileURLToPath(import.meta.resolve('@playwright/test'));
    fs.writeFileSync(path.join(directory, 'policy.spec.ts'), `
      import { test, expect } from ${JSON.stringify(playwright)};
      import { quarantine, QUARANTINE } from ${JSON.stringify(quarantine)};
      // Synthetic policy cases must not depend on currently quarantined application scenarios.
      QUARANTINE['fixture-recovered'] = { file: 'policy.spec.ts', cause: 'Synthetic recovery', deadline: '2099-01-01' };
      QUARANTINE['fixture-failed'] = { file: 'policy.spec.ts', cause: 'Synthetic failure', deadline: '2099-01-01' };
      quarantine(test, 'fixture-recovered', 'recovers', async ({}, info) => { expect(info.retry).toBe(1); });
      test('ordinary failure', () => { expect(false).toBe(true); });
      quarantine(test, 'fixture-failed', 'persistent failure', async () => { expect(false).toBe(true); });
    `);
    fs.writeFileSync(path.join(directory, 'playwright.config.ts'), `export default { testDir: '.', outputDir: ${JSON.stringify(path.join(directory, 'test-results'))}, workers: 1, retries: 0, reporter: [["list"], [${JSON.stringify(reporter)}]] };`);
    const result = spawnSync(process.execPath, [require.resolve('@playwright/test/cli'), 'test', '-c', path.join(directory, 'playwright.config.ts')], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, TOMOLA_BROWSER_REPORT: output, TOMOLA_BROWSER_COMPLETE: "1" } });
    assert.equal(result.status, 1, result.stderr);
    const evidence = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.equal(evidence.complete, false, 'failed runs must not supply grouping weights');
    assert.equal(evidence.status, 'failed');
    const rows = evidence.tests;
    assert.ok(rows.length, result.stdout + result.stderr);
    assert.ok(rows.every(row => row.file === "policy.spec.ts"), "helper calls must retain the owning spec file");
    const attempts = title => rows.filter(row => row.title.endsWith(title)).map(row => [row.retry, row.status]);
    assert.deepEqual(attempts('recovers'), [[0, 'failed'], [1, 'passed']]);
    assert.deepEqual(attempts('ordinary failure'), [[0, 'failed']]);
    assert.deepEqual(attempts('persistent failure'), [[0, 'failed'], [1, 'failed']]);
    assert.ok(rows.filter(row => !row.title.endsWith('ordinary failure')).every(row => row.quarantine));
    assert.ok(rows.filter(row => row.quarantine).every(row => row.line === null), 'helper declarations must not be reported as spec lines');
    assert.ok(rows.filter(row => row.title.endsWith('ordinary failure')).every(row => Number.isInteger(row.line) && row.line > 0));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
