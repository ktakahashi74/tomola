import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';

function sourceFiles(root) {
  return ['app', 'server', 'scripts', 'tests', 'e2e', 'e2e-prod'].flatMap(dir => {
    const target = path.join(root, dir);
    return fs.existsSync(target) ? fs.readdirSync(target, { recursive: true }).filter(file => /\.(?:[cm]?js|tsx?)$/.test(file)).map(file => `${dir}/${file}`) : [];
  }).filter(file => !file.startsWith('app/paraglide/')).sort();
}

export function selectFocused(root, changed, diagnostics = {}) {
  diagnostics.reasons = [];
  for (const file of changed) if (file.startsWith('/') || file.includes('\\') || path.posix.normalize(file) !== file || file.startsWith('../')) throw new Error('Invalid changed path');
  const files = sourceFiles(root), units = files.filter(file => file.startsWith('tests/') && file.endsWith('.test.ts'));
  const browsers = files.filter(file => file.startsWith('e2e/') && file.endsWith('.spec.ts'));
  const production = files.filter(file => file.startsWith('e2e-prod/') && file.endsWith('.spec.ts'));
  if (!changed.length) return { unit: [], browser: [], all: false };
  // Configuration, assets, fixtures and unknown inputs can affect tests through fs reads or runtime imports.
  const known = file => /^tests\/.*\.test\.ts$|^e2e(?:-prod)?\/.*\.spec\.ts$|^(?:app|server)\/.*\.tsx?$|^docs\/|^README\.md$/.test(file);
  const unknown = changed.filter(file => !known(file));
  if (unknown.length) {
    diagnostics.reasons.push({ reason: 'unknown-inputs', files: unknown.slice(0, 20), count: unknown.length });
    return { unit: units, browser: browsers, ...(production.length ? { production } : {}), all: true };
  }
  const affected = new Set(changed), implicit = new Set();
  const edges = new Map();
  for (const file of files) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    const imports = ts.preProcessFile(text, true, true).importedFiles;
    const dependencies = imports.flatMap(({ fileName }) => {
      const base = fileName.startsWith('~/') ? `app/${fileName.slice(2)}` : fileName.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(file), fileName)) : null;
      if (!base) return [];
      const candidates = [base, base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'), `${base}.ts`, `${base}.tsx`, `${base}.mjs`, `${base}/index.ts`];
      return candidates.filter(candidate => files.includes(candidate) || changed.includes(candidate));
    });
    edges.set(file, dependencies);
    if (file.startsWith('tests/') && /(?:readFile|readFileSync|globSync|import\s*\(\s*(?![\"\']))/.test(text)) implicit.add(file);
  }
  for (let again = true; again;) {
    again = false;
    for (const [file, dependencies] of edges) if (!affected.has(file) && dependencies.some(dependency => affected.has(dependency))) { affected.add(file); again = true; }
  }
  const productChanged = changed.some(file => /^(app|server)\//.test(file));
  let unit = units.filter(file => affected.has(file) || productChanged && implicit.has(file));
  diagnostics.reasons.push({ reason: 'imports-and-changed-tests' });
  if (productChanged) diagnostics.reasons.push({ reason: 'product-change', unit: 'imports-and-runtime-readers', browser: 'all' });
  if (changed.some(file => /^docs\/|^README\.md$/.test(file))) unit = [...new Set([...unit, ...units.filter(file => /documentation|principles|guides|why/.test(file))])];
  if (changed.some(file => /^docs\/|^README\.md$/.test(file))) diagnostics.reasons.push({ reason: 'documentation-readers' });
  // Screen coverage does not import its routes. Keep all screen scenarios for product changes.
  const browser = productChanged ? browsers : browsers.filter(file => affected.has(file));
  if (productChanged && !unit.length) {
    diagnostics.reasons.push({ reason: 'product-change-without-unit-match' });
    unit = units;
  }
  const prod = production.filter(file => affected.has(file) || changed.some(input => input.startsWith('server/')));
  return { unit: unit.sort(), browser, ...(prod.length ? { production: prod } : {}), all: false };
}

export function changedFiles(root, base = 'origin/main', diagnostics = {}) {
  if (!/^[\w./-]+$/.test(base) || base.startsWith('-')) throw new Error('Invalid comparison ref');
  const git = args => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (result.status !== 0) throw new Error('Could not inspect changed files');
    return result.stdout;
  };
  const ancestor = git(['merge-base', base, 'HEAD']).trim();
  diagnostics.base = base;
  diagnostics.mergeBase = ancestor;
  return [...new Set([...git(['diff', '--name-only', '-z', ancestor]).split('\0'), ...git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0')].filter(Boolean))].sort();
}
