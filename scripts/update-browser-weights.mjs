import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function measuredWeights(records, previous = {}) {
  const samples = new Map();
  for (const record of records) {
    if (record.mode !== "private" || record.complete !== true) continue;
    const files = new Map();
    for (const test of record.tests ?? []) {
      if (!test.file?.startsWith('e2e/') || !test.file.endsWith('.spec.ts')) continue;
      const file = test.file.slice(4);
      const row = files.get(file) ?? { good: true, ms: 0 };
      if (test.status === 'skipped') continue;
      if (test.retry !== 0 || test.status !== 'passed' || !Number.isFinite(test.durationMs) || test.durationMs < 0) row.good = false;
      else row.ms += test.durationMs;
      files.set(file, row);
    }
    for (const [file, row] of files) if (row.good && row.ms > 0) {
      const values = samples.get(file) ?? []; values.push(row.ms / 1000); samples.set(file, values);
    }
  }
  const weights = { ...previous };
  for (const [file, values] of samples) {
    values.sort((a, b) => a - b);
    const middle = Math.floor(values.length / 2);
    const median = values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
    weights[file] = Math.max(0.01, Math.round(median * 100) / 100);
  }
  return Object.fromEntries(Object.entries(weights).sort());
}

export function browserLogRecord(text) {
  const tests = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(✓|✘|×)\s+\d+ \[[^\]]+\] › (e2e\/[^:]+\.spec\.ts):\d+:\d+ › (.*) \(([\d.]+)(ms|s|m)\)$/.exec(line);
    if (!match) continue;
    tests.push({ file: match[2], title: match[3], status: match[1] === '✓' ? 'passed' : 'failed', retry: 0, durationMs: Number(match[4]) * ({ ms: 1, s: 1000, m: 60000 })[match[5]] });
  }
  return { mode: 'private', complete: /^\s*\d+ passed \(/m.test(text) && !/^\s*\d+ (?:failed|interrupted|did not run|timed out|flaky)\b/m.test(text), tests };
}

export function readBrowserRecords(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = fs.readdirSync(directory, { recursive: true });
  const json = files.filter(file => /(?:^|\/)browser-results-[\w-]+\.json$/.test(file) && !file.includes('browser-workspaces/')).map(file => JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8')));
  if (json.some(record => record.mode === 'private' && record.complete)) return json;
  // Earlier check records keep per-case durations in each private group's list log.
  return files.filter(file => /browser-logs\/.*-[ab]\.log$/.test(file)).map(file => browserLogRecord(fs.readFileSync(path.join(directory, file), 'utf8')));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const destination = new URL('./browser-weights.json', import.meta.url);
  const records = readBrowserRecords(path.resolve('.data/checks'));
  if (!records.some(record => record.mode === 'private' && record.complete && record.tests.length)) { console.error('No browser timing records found. Run browser checks first.'); process.exitCode = 1; }
  else {
    const weights = measuredWeights(records, JSON.parse(fs.readFileSync(destination, 'utf8')));
    if (process.argv.includes('--write')) fs.writeFileSync(destination, JSON.stringify(weights, null, 2) + '\n');
    else console.log(JSON.stringify(weights, null, 2));
  }
}
