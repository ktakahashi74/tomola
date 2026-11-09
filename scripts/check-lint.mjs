import path from 'node:path';
import { ESLint } from 'eslint';
import { countFindings, checkBaseline } from './finding-baseline.mjs';

try {
  const eslint = new ESLint();
  const results = await eslint.lintFiles(['app', 'server', 'scripts', 'tests', 'e2e', 'e2e-prod', '*.ts']);
  const findings = results.flatMap(result => result.messages.map(message => ({ file: path.relative(process.cwd(), result.filePath).split(path.sep).join('/'), rule: message.ruleId, fatal: message.fatal })));
  if (findings.some(row => row.fatal || !row.rule)) throw new Error('Lint parse/configuration error; it cannot be baselined. Run pnpm exec eslint . for details.');
  checkBaseline(countFindings(findings), new URL('./check-baselines/lint.json', import.meta.url), process.argv.includes('--update-baseline'));
} catch (error) { console.error(error.message); process.exitCode = 1; }
