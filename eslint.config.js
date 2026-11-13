import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['**/node_modules/', '**/data/', '**/logs/'] },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: globals.node },
    // Price lookups and Discord cleanup calls are best effort and swallow errors on purpose.
    rules: { 'no-empty': ['error', { allowEmptyCatch: true }] },
  },
  { files: ['**/*.cjs'], languageOptions: { sourceType: 'commonjs' } },
];
