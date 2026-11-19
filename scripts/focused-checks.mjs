import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import ts from 'typescript';

function sourceFiles(root) {
  const files = ['app', 'server', 'scripts', 'tests', 'e2e', 'e2e-prod'].flatMap(dir => {
    const target = path.join(root, dir);
    if (!fs.existsSync(target)) return [];
    return fs.readdirSync(target, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile() && /\.(?:[cm]?js|tsx?)$/.test(entry.name) && !entry.name.startsWith('.env'))
      .map(entry => path.relative(root, path.join(entry.parentPath, entry.name)))
      .filter(file => !file.startsWith('app/paraglide/'));
  });
  if (fs.lstatSync(path.join(root, 'server.ts'), { throwIfNoEntry: false })?.isFile()) files.push('server.ts');
  return files.sort();
}

function git(root, args) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

function changedMessageKeys(root, mergeBase, file) {
  const catalogPath = /^messages\/[\w-]+\.json$/;
  if (!mergeBase || !catalogPath.test(file)) return null;
  try {
    const previous = git(root, ['show', `${mergeBase}:${file}`]);
    const current = path.join(root, file);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat && !stat.isFile()) return null;
    if (previous.status !== 0) {
      const listed = git(root, ['ls-tree', mergeBase, '--', file]);
      if (listed.status !== 0 || listed.stdout) return null;
    }
    const before = JSON.parse(previous.status === 0 ? previous.stdout : '{}');
    const after = JSON.parse(stat ? fs.readFileSync(current, 'utf8') : '{}');
    if ([before, after].some(value => !value || typeof value !== 'object' || Array.isArray(value))) return null;
    return [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter(key => key !== '$schema' && !isDeepStrictEqual(before[key], after[key]));
  } catch {
    return null;
  }
}

// Recognize static keys in generated message calls, JSON property reads and literal lookups.
function messageReferences(file, text, keys) {
  if (!keys.size || ![...keys].some(key => text.includes(key))) return [];
  const matched = new Set();
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest);
  const visit = node => {
    if (ts.isPropertyAccessExpression(node) && keys.has(node.name.text)) matched.add(node.name.text);
    if (ts.isImportSpecifier(node) || ts.isBindingElement(node)) {
      const name = (node.propertyName ?? node.name).text;
      if (keys.has(name)) matched.add(name);
    }
    if (ts.isStringLiteralLike(node) && keys.has(node.text)) matched.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...matched];
}

function affectedFiles(dependents, inputs) {
  const affected = new Set(inputs);
  for (const input of affected) {
    for (const importer of dependents.get(input) ?? []) affected.add(importer);
  }
  return affected;
}

const testSelection = (files) => ({
  unit: files.filter(file => file.startsWith('tests/') && file.endsWith('.test.ts')),
  browser: files.filter(file => file.startsWith('e2e/') && file.endsWith('.spec.ts')),
  production: files.filter(file => file.startsWith('e2e-prod/') && file.endsWith('.spec.ts')),
});

export function selectFocused(root, changed, diagnostics = {}, explicit = []) {
  diagnostics.reasons = [];
  if (explicit.length) diagnostics.reasons.push({ reason: 'explicit-tests', files: explicit });
  for (const file of changed) if (file.startsWith('/') || file.includes('\\') || path.posix.normalize(file) !== file || file.startsWith('../')) throw new Error('Invalid changed path');
  if (!changed.length) return { ...testSelection([...explicit].sort()), all: false };
  const files = sourceFiles(root);
  const { unit: units, browser: browsers, production } = testSelection(files);
  const known = file => /^tests\/.*\.test\.ts$|^e2e(?:-prod)?\/.*\.spec\.ts$|^(?:app|server)\/.*\.tsx?$|^server\.ts$|^messages\/|^docs\/|^README\.md$/.test(file);
  const unknown = changed.filter(file => !known(file));
  if (unknown.length) diagnostics.reasons.push({ reason: 'unknown-inputs', files: unknown.slice(0, 20), count: unknown.length, unit: 'all' });

  const messageFiles = changed.filter(file => file.startsWith('messages/'));
  const inputs = changed.filter(file => !file.startsWith('messages/'));
  const keys = new Set(), unreadable = [];
  for (const file of messageFiles) {
    const diff = changedMessageKeys(root, diagnostics.mergeBase, file);
    if (diff) for (const key of diff) keys.add(key);
    else unreadable.push(file);
  }

  const candidates = new Set([...files, ...inputs]);
  const dependents = new Map();
  const implicit = new Set(), readers = [], matchedKeys = new Set(), messageUsers = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    for (const { fileName } of ts.preProcessFile(text, true, true).importedFiles) {
      const base = fileName.startsWith('~/') ? `app/${fileName.slice(2)}` : fileName.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(file), fileName)) : null;
      if (!base) continue;
      for (const dependency of [base, base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'), `${base}.ts`, `${base}.tsx`, `${base}.mjs`, `${base}/index.ts`, `${base}/index.tsx`]) {
        if (!candidates.has(dependency)) continue;
        if (!dependents.has(dependency)) dependents.set(dependency, new Set());
        dependents.get(dependency).add(file);
      }
    }
    if (file.startsWith('tests/') && /(?:readFile|readFileSync|globSync|import\s*\(\s*(?!['"]))/.test(text)) implicit.add(file);
    if (messageFiles.length && /['"`](?:(?:\.\.\/)+|\.\/)?messages(?:\/|['"`])/.test(text)) readers.push(file);
    const matches = messageReferences(file, text, keys);
    if (matches.length) messageUsers.push(file);
    for (const key of matches) matchedKeys.add(key);
  }

  const affected = affectedFiles(dependents, [...inputs, ...messageUsers]);
  const productChanged = changed.some(file => /^(?:app\/|server\/|server\.ts$)/.test(file));
  const docsChanged = changed.some(file => /^(?:docs\/|README\.md$)/.test(file));
  const explicitSet = new Set(explicit);
  diagnostics.reasons.push({ reason: 'imports-and-changed-tests' });
  if (productChanged) diagnostics.reasons.push({ reason: 'product-change', unit: 'imports-and-runtime-readers' });
  if (docsChanged) diagnostics.reasons.push({ reason: 'documentation-readers' });
  if (messageFiles.length) {
    diagnostics.reasons.push({ reason: 'message-keys', count: keys.size, matched: matchedKeys.size, keys: [...keys].sort().slice(0, 20) });
  }
  const fallback = unreadable.length > 0 || matchedKeys.size < keys.size;
  if (fallback) diagnostics.reasons.push({ reason: 'message-readers', unreadable: unreadable.slice(0, 20), unmatched: keys.size - matchedKeys.size });
  const affectedReaders = fallback ? affectedFiles(dependents, readers) : new Set();

  let unit = units.filter(file => affected.has(file) || explicitSet.has(file) || productChanged && implicit.has(file) ||
    docsChanged && /documentation|principles|guides|why/.test(file) || affectedReaders.has(file));
  if (unknown.length) unit = units;
  else if (productChanged && !unit.length) {
    diagnostics.reasons.push({ reason: 'product-change-without-unit-match' });
    unit = units;
  }
  const chosen = file => affected.has(file) || explicitSet.has(file);
  return { unit, browser: browsers.filter(chosen), production: production.filter(chosen), all: unknown.length > 0 };
}

export function changedFiles(root, base = 'origin/main', diagnostics = {}) {
  if (!/^[\w./-]+$/.test(base) || base.startsWith('-')) throw new Error('Invalid comparison ref');
  const inspect = args => {
    const result = git(root, args);
    if (result.status !== 0) throw new Error('Could not inspect changed files');
    return result.stdout;
  };
  const ancestor = inspect(['merge-base', base, 'HEAD']).trim();
  diagnostics.base = base;
  diagnostics.mergeBase = ancestor;
  return [...new Set([...inspect(['diff', '--name-only', '--no-renames', '-z', ancestor]).split('\0'), ...inspect(['ls-files', '--others', '--exclude-standard', '-z']).split('\0')].filter(Boolean))].sort();
}
