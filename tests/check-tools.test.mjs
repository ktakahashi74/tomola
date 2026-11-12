import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countFindings, increases } from '../scripts/finding-baseline.mjs';
import { disclosureFindings } from '../scripts/check-disclosure.mjs';
import { measuredWeights } from '../scripts/update-browser-weights.mjs';

test('baseline budgets are per file and rule; improvements cannot offset regressions elsewhere', () => {
  const baseline = countFindings([{ file: 'a.ts', rule: 'hooks' }, { file: 'a.ts', rule: 'hooks' }]);
  assert.deepEqual(increases(countFindings([{ file: 'a.ts', rule: 'hooks' }]), baseline), []);
  assert.deepEqual(increases(countFindings([{ file: 'a.ts', rule: 'hooks' }, { file: 'b.ts', rule: 'hooks' }]), baseline), [{ file: 'b.ts', rule: 'hooks', count: 1, allowed: 0 }]);
  assert.throws(() => increases({ 'a.ts': { hooks: -1 } }, baseline));
});

test('disclosure detects private references but allows portable paths and ordinary prose', () => {
  const privateText = ['/home/' + 'example/work/app', 'decision ' + '123', 'handoff/' + 'to-codex/task.md', 'deploy.test.' + 'internal'];
  const findings = disclosureFindings('sample.ts', privateText.join('\n'));
  assert.deepEqual(new Set(findings.map(row => row.rule)), new Set(['local-path', 'internal-reference', 'handoff-path', 'private-host']));
  assert.deepEqual(disclosureFindings('sample.ts', 'https://example.com /assets/file.js The decision was made yesterday. localhost:5351'), []);
});

test('disclosure covers numbered work references and distinguishes local properties from hosts', () => {
  const references = [
    'decision ' + '88', 'decisions ' + '12, 34', 'plan ' + '8', 'subplan ' + '7B',
    'part ' + '7D2', 'task ' + '8D', 'work ' + '8B1-a',
    'design ' + '§8.6', 'design ' + '§§6.2, 8.6', 'design ' + '12.1',
    'design section ' + '8.6', 'design decision ' + '78',
    '決定' + '84', '部分計画' + '7B', '作業' + '7B',
  ];
  for (const reference of references) {
    assert.deepEqual(disclosureFindings('sample.ts', reference), [{ file: 'sample.ts', rule: 'internal-reference' }], reference);
  }
  for (const host of ['"printer.' + 'local"', '`printer.' + 'local`', 'https://printer.' + 'local/path', 'ss' + 'h printer.' + 'local', 'deploy.' + 'internal', 'deploy.' + 'lan']) {
    assert.deepEqual(disclosureFindings('sample.ts', host), [{ file: 'sample.ts', rule: 'private-host' }], host);
  }
  assert.deepEqual(disclosureFindings('sample.ts', 'items.map(item => item.local); const local = config.local; item.local.name;'), []);
  for (const file of ['notes.md', 'compose.yaml', 'deploy.sh', 'Caddyfile']) {
    assert.deepEqual(disclosureFindings(file, 'Run it on nas.' + 'local first.'), [{ file, rule: 'private-host' }], file);
  }
  assert.deepEqual(disclosureFindings('sample.ts', 'const last = parts - 1; a[part-1]; <div id="task-2">; retry the work 3 times;'), []);
});

test('disclosure enforces a zero construction allowance only in the five Markdown regression files', () => {
  const baseline = JSON.parse(fs.readFileSync(new URL('../scripts/check-baselines/disclosure.json', import.meta.url), 'utf8'));
  const files = ['tests/markdown-budget.test.ts', 'tests/markdown-budget-entries.test.ts', 'tests/moderator-fix.test.ts', 'e2e/markdown-budget.spec.ts', 'e2e-prod/markdown-budget.spec.ts'];
  for (const file of files) {
    assert.equal(baseline[file]?.['costly-input-construction'] ?? 0, 0);
    for (const call of ['.repeat(2)', '.repeat (2)']) {
      const rows = disclosureFindings(file, `const sample = "small"${call};`);
      assert.deepEqual(rows, [{ file, rule: 'costly-input-construction' }]);
      assert.deepEqual(increases(countFindings(rows), baseline), [{ file, rule: 'costly-input-construction', count: 1, allowed: 0 }]);
    }
    assert.deepEqual(disclosureFindings(file, fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')).filter(row => row.rule === 'costly-input-construction'), []);
  }
  for (const file of ['app/lib/markdown-budget.server.ts', 'tests/ordinary.test.ts', 'e2e/ordinary.spec.ts', 'e2e-prod/ordinary.spec.ts']) {
    assert.deepEqual(disclosureFindings(file, 'const sample = "small".repeat(2);'), []);
  }
});

test('browser weights use successful first attempts, relative files, and preserve measurements without new evidence', () => {
  const records = [{ mode: "private", complete: true, tests: [
    { file: 'e2e/a.spec.ts', title: 'one', status: 'passed', retry: 0, durationMs: 1200 },
    { file: 'e2e/a.spec.ts', title: 'two', status: 'passed', retry: 0, durationMs: 2800 },
    { file: 'e2e/b.spec.ts', title: 'bad', status: 'failed', retry: 0, durationMs: 90000 },
    { file: 'e2e/b.spec.ts', title: 'bad', status: 'passed', retry: 1, durationMs: 1000 },
    { file: 'e2e-prod/a.spec.ts', title: 'prod', status: 'passed', retry: 0, durationMs: 100000 },
  ] }];
  assert.deepEqual(measuredWeights(records, { 'retained.spec.ts': 9 }), { 'a.spec.ts': 4, 'retained.spec.ts': 9 });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { selectFocused } from '../scripts/focused-checks.mjs';

test('focused follows module dependencies and includes implicit route/document checks conservatively', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'focused-selection-'));
  const write = (file, text) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); };
  try {
    write('app/lib/value.ts', 'export const value = 1;');
    write('app/lib/wrapper.ts', 'export {value} from "./value";');
    write('tests/value.test.ts', 'import {value} from "../app/lib/wrapper";');
    write('tests/unrelated.test.ts', '');
    write('tests/dynamic.test.ts', 'await import(`../app/routes/${name}`);');
    write('tests/documentation.test.ts', '');
    write('e2e/view.spec.ts', '');
    write('e2e/other.spec.ts', '');
    write('e2e-prod/live.spec.ts', '');
    assert.deepEqual(selectFocused(root, ['app/lib/value.ts']), { unit: ['tests/dynamic.test.ts', 'tests/value.test.ts'], browser: ['e2e/other.spec.ts', 'e2e/view.spec.ts'], all: false });
    assert.deepEqual(selectFocused(root, ['tests/value.test.ts']).unit, ['tests/value.test.ts']);
    assert.deepEqual(selectFocused(root, ['e2e/view.spec.ts']).browser, ['e2e/view.spec.ts']);
    assert.deepEqual(selectFocused(root, ['docs/deploy.md']).unit, ['tests/documentation.test.ts']);
    assert.equal(selectFocused(root, ['vitest.config.ts']).all, true);
    assert.deepEqual(selectFocused(root, ['e2e-prod/live.spec.ts']), { unit: [], browser: [], production: ['e2e-prod/live.spec.ts'], all: false });
    assert.deepEqual(selectFocused(root, []), { unit: [], browser: [], all: false });
    assert.throws(() => selectFocused(root, ['../outside.ts']));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

import { Linter } from 'eslint';
import parser from '@typescript-eslint/parser';
import writerRule from '../scripts/lint/writer-gate.mjs';
import sameOriginRule from '../scripts/lint/same-origin.mjs';
import { SAME_ORIGIN_EXCEPTIONS } from '../scripts/lint/same-origin-exceptions.mjs';
test('same-origin AST checks action calls, aliases and wrappers with explicit exceptions', () => {
  const lint = (code, filename = 'route.ts') => new Linter().verify(code, [{ files: ['**/*.{ts,tsx}'], languageOptions: { parser }, plugins: { local: { rules: { origin: sameOriginRule } } }, rules: { 'local/origin': 'error' } }], { filename });
  const prelude = 'import {assertSameOrigin as check} from "~/lib/http/csrf.server";';
  for (const code of [
    'export async function action() { check(request); }',
    'export const action = async () => { check (request); };',
    'async function run() { check(request); } export const action = wrapper(run);',
    'const run = () => check(request); export { run as action };',
  ]) assert.equal(lint(prelude + code).length, 0, code);
  for (const code of [
    'export function loader() { check(request); } export function action() { /* check(request) */ return null; }',
    'export function action() { const check = () => null; return check(); }',
    'export { action } from "./other";',
  ]) assert.equal(lint(prelude + code).length, 1);
  assert.equal(lint('import {assertSameOrigin} from "other"; export function action() { assertSameOrigin(request); }').length, 1);
  for (const [filename, reason] of Object.entries(SAME_ORIGIN_EXCEPTIONS)) {
    assert.ok(reason.trim());
    assert.equal(lint('export function action() { return null; }', filename).length, 0);
  }
});
const lintAction = code => new Linter().verify(code, [{ languageOptions: { parser }, plugins: { local: { rules: { writer: writerRule } } }, rules: { 'local/writer': 'error' } }]);
test('writer gate AST handles whitespace, aliases and wrappers without borrowing a loader gate or a comment', () => {
  const prelude = 'import {requireWriter as check} from "~/lib/auth/session.server";';
  assert.equal(lintAction(prelude + 'export const action = async () => { await check (request); };').length, 0);
  assert.equal(lintAction(prelude + 'async function run() { await check(request); } export const action = wrapper(run);').length, 0);
  assert.equal(lintAction(prelude + 'export function loader() { return check(request); } export function action() { /* check(request) */ return null; }').length, 1);
  assert.equal(lintAction(prelude + 'export function action() { const check = () => null; return check(); }').length, 1);
  assert.equal(lintAction(prelude + 'import {requireUser} from "~/lib/auth/session.server"; export async function action() { await requireUser(request); await check(request); }').length, 1);
});

import { budgetViolations, PAGE_GZIP_GROWTH_LIMIT } from '../scripts/editor-bundle-budget.ts';
test('page growth fails at the threshold and absolute budgets remain enforced', () => {
  const previous = { 'routes/topic': 100000, 'routes/topic-new': 450 * 1024 };
  assert.deepEqual(budgetViolations([{ routeId: 'routes/topic', gzipBytes: 100000 + PAGE_GZIP_GROWTH_LIMIT - 1 }], previous), []);
  assert.equal(budgetViolations([{ routeId: 'routes/topic', gzipBytes: 100000 + PAGE_GZIP_GROWTH_LIMIT }], previous)[0].kind, 'growth');
  assert.equal(budgetViolations([{ routeId: 'routes/topic-new', gzipBytes: 456 * 1024 }], previous).some(row => row.kind === 'absolute'), true);
  assert.equal(budgetViolations([{ routeId: 'routes/new', gzipBytes: 1 }], previous)[0].kind, 'missing-baseline');
  assert.throws(() => budgetViolations([{ routeId: 'routes/topic', gzipBytes: 2 }], { 'routes/topic': NaN }));
});

import { browserLogRecord } from '../scripts/update-browser-weights.mjs';
test('existing private group logs supply measured weights without treating a failed file as a good sample', () => {
  const record = browserLogRecord('  ✓  1 [chromium] › e2e/one.spec.ts:1:1 › first (200ms)\n  ✓  2 [chromium] › e2e/one.spec.ts:3:1 › second (1.2s)\n  ✘  3 [chromium] › e2e/bad.spec.ts:1:1 › failed (90.0s)\n  1 failed\n  2 passed (1.5m)');
  assert.equal(record.complete, false);
  assert.deepEqual(measuredWeights([record]), {});
  const passed = browserLogRecord('  ✓  1 [chromium] › e2e/one.spec.ts:1:1 › first (200ms)\n  ✓  2 [chromium] › e2e/one.spec.ts:3:1 › second (1.2s)\n  2 passed (1.5s)');
  assert.deepEqual(measuredWeights([passed]), { 'one.spec.ts': 1.4 });
  assert.equal(browserLogRecord('  1 interrupted\n  2 passed (2s)').complete, false);
  assert.equal(browserLogRecord('  ✓ 1 [chromium] › e2e/one.spec.ts:1:1 › interrupted (2s)').complete, false);
});

import lintConfig from '../eslint.config.mjs';
test('the actual lint config parses TypeScript and detects Hooks and accessibility regressions without type services', () => {
  const messages = new Linter().verify('import { useEffect } from "react"; export function Example({on}: {on: boolean}) { if (on) useEffect(() => {}, []); return <img src="/sample.webp" />; }', lintConfig, { filename: 'app/components/example.tsx' });
  assert.ok(messages.some(row => row.ruleId === 'react-hooks/rules-of-hooks'));
  assert.ok(messages.some(row => row.ruleId === 'jsx-a11y/alt-text'));
  assert.ok(!messages.some(row => row.fatal));
});
