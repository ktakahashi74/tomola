import fs from 'node:fs';

export function countFindings(findings) {
  const counts = {};
  for (const { file, rule } of findings) {
    counts[file] ??= {};
    counts[file][rule] = (counts[file][rule] ?? 0) + 1;
  }
  return Object.fromEntries(Object.keys(counts).sort().map(file => [file, Object.fromEntries(Object.entries(counts[file]).sort())]));
}

export function increases(current, baseline) {
  const added = [];
  for (const counts of [current, baseline]) {
    if (!counts || typeof counts !== 'object' || Array.isArray(counts)) throw new Error('Invalid finding baseline');
    for (const rules of Object.values(counts)) {
      if (!rules || typeof rules !== 'object' || Array.isArray(rules)) throw new Error('Invalid rule counts');
      for (const n of Object.values(rules)) if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid finding count');
    }
  }
  for (const [file, rules] of Object.entries(current)) for (const [rule, count] of Object.entries(rules)) {
    const allowed = baseline[file]?.[rule] ?? 0;
    if (count > allowed) added.push({ file, rule, count, allowed });
  }
  return added;
}

export function checkBaseline(counts, destination, update = false) {
  if (update) {
    fs.mkdirSync(new URL('.', destination), { recursive: true });
    fs.writeFileSync(destination, JSON.stringify(counts, null, 2) + '\n');
    console.log('Baseline written; review its diff before committing.');
    return;
  }
  const added = increases(counts, JSON.parse(fs.readFileSync(destination, 'utf8')));
  for (const row of added) console.error(`${row.file}: ${row.rule}: ${row.count} (baseline ${row.allowed})`);
  if (added.length) process.exitCode = 1;
  else console.log('No finding counts increased.');
}
