import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['web/', 'node_modules/'] },
  js.configs.recommended,
  { languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: globals.node } },
  // The end-to-end script passes functions to the browser, so it also sees browser globals.
  { files: ['scripts/e2e.js'], languageOptions: { globals: globals.browser } },
];
