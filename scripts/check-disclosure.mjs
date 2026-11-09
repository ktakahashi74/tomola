import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { checkBaseline, countFindings } from './finding-baseline.mjs';

const patterns = {
  'local-path': /(?:\/home\/[^\s/'"`]+\/|\/Users\/[^\s/'"`]+\/|[A-Z]:\\Users\\[^\\\s]+\\)/g,
  // Task, part and work numbers need a letter suffix (7B, 8D2), so ordinary code such as `parts - 1` or `task-2` passes.
  'internal-reference': /(?:\b(?:decisions?|subplans?|plans?)(?:\s*#\s*|\s+)\d+[a-z0-9.-]*|\b(?:tasks?|parts?|work)(?:\s*#\s*|\s+)\d+[a-z][a-z0-9.-]*|\bdesign\s*(?:(?:sections?|decisions?)\s*|§{1,2}\s*)?\d+(?:\.\d+)*|(?:決定|部分計画|作業)\s*\d+[a-z0-9.-]*)/gi,
  'handoff-path': /(?:handoff\/(?:to-codex|design-notes|reviews)\/|\b(?:instructions|reports)\/\d{4}-\d{2}-\d{2}[-/])/g,
  // Prose and configuration files: any .local name is a private host.
  'private-host': /(?:\b[\w.-]+\.(?:internal|lan|local)\b|\bssh\s+(?:[\w.-]+@)?(?!localhost\b)[\w.-]+)/g,
};

// In code, a .local name needs a URL or quoted-host context to distinguish it from JavaScript property access.
const codeHost = /(?:\b[\w.-]+\.(?:internal|lan)\b|(?:(?:https?|wss?):\/\/|["'`])[\w.-]+\.local\b|\bssh\s+(?:[\w.-]+@)?(?!localhost\b)[\w.-]+)/g;
const isCode = file => /\.(?:[cm]?[jt]sx?)$/.test(file);

// Keep concrete costly constructions out of the public Markdown regressions.
const guardedMarkdownFiles = new Set([
  'tests/markdown-budget.test.ts', 'tests/markdown-budget-entries.test.ts',
  'tests/moderator-fix.test.ts', 'e2e/markdown-budget.spec.ts', 'e2e-prod/markdown-budget.spec.ts',
]);

export function disclosureFindings(file, source) {
  const findings = Object.entries(patterns).flatMap(([rule, pattern]) => [...source.matchAll(rule === 'private-host' && isCode(file) ? codeHost : pattern)].map(() => ({ file, rule })));
  if (guardedMarkdownFiles.has(file)) for (const _match of source.matchAll(/\.repeat\s*\(/g)) findings.push({ file, rule: 'costly-input-construction' });
  return findings;
}

export function scanDisclosure(root) {
  const result = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error('Could not enumerate disclosure inputs');
  const findings = [];
  for (const file of new Set(result.stdout.split('\0').filter(Boolean))) {
    if (file.startsWith('scripts/check-baselines/') || /(^|\/)\.env(?:$|\.(?!example$))/.test(file)) continue;
    const target = path.join(root, file), stat = fs.lstatSync(target, { throwIfNoEntry: false });
    if (!stat?.isFile()) continue;
    const buffer = fs.readFileSync(target);
    if (buffer.includes(0)) continue;
    findings.push(...disclosureFindings(file, buffer.toString('utf8')));
  }
  return countFindings(findings);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { checkBaseline(scanDisclosure(process.cwd()), new URL('./check-baselines/disclosure.json', import.meta.url), process.argv.includes('--update-baseline')); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
