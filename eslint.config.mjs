import parser from '@typescript-eslint/parser';
import hooks from 'eslint-plugin-react-hooks';
import a11y from 'eslint-plugin-jsx-a11y';
import writer from './scripts/lint/writer-gate.mjs';
import sameOrigin from './scripts/lint/same-origin.mjs';

export default [
  { ignores: ['node_modules/**', '.data/**', 'build/**', '.react-router/**', 'app/paraglide/**', 'project.inlang/**'] },
  {
    files: ['app/**/*.{ts,tsx}', 'server/**/*.ts', 'scripts/**/*.{ts,mjs}', 'tests/**/*.{ts,mjs}', 'e2e/**/*.ts', 'e2e-prod/**/*.ts', '*.ts'],
    languageOptions: { parser, ecmaVersion: 'latest', sourceType: 'module', parserOptions: { ecmaFeatures: { jsx: true } } },
    plugins: { 'react-hooks': hooks, 'jsx-a11y': a11y },
    rules: { 'react-hooks/rules-of-hooks': 'error', 'react-hooks/exhaustive-deps': 'error', ...a11y.configs.recommended.rules },
  },
  {
    files: ['app/**/*.{ts,tsx}'],
    rules: { ...hooks.configs.flat.recommended.rules, 'react-hooks/rules-of-hooks': 'error', 'react-hooks/exhaustive-deps': 'error' },
  },
  {
    files: ['e2e/**/*.ts', 'e2e-prod/**/*.ts'],
    rules: { 'react-hooks/rules-of-hooks': 'off', 'react-hooks/exhaustive-deps': 'off' },
  },
  { files: ['app/routes/*.{ts,tsx}'], plugins: { local: { rules: { 'writer-gate': writer, 'same-origin': sameOrigin } } }, rules: { 'local/writer-gate': 'error', 'local/same-origin': 'error' } },
];
