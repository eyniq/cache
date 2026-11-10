// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// Ecosystem-agnostic layers must never reach into an adapter (DESIGN.md section 15).
const adapterPattern = {
  group: ['**/adapters/**'],
  message: 'The core never imports from an adapter. Add a contract in src/core/contracts.ts.',
};
// Zero runtime dependencies: production code imports only node: builtins and relative files.
const runtimeDepPattern = {
  regex: '^(?!node:|\\.)',
  message: 'No runtime dependencies (see docs/DEPENDENCIES.md).',
};

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**', '.claude/**', 'deploy/**'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['eslint.config.js'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['src/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [adapterPattern, runtimeDepPattern] }],
    },
  },
  {
    // The adapters themselves and the composition root may import adapter code.
    files: ['src/adapters/**', 'src/main.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: [runtimeDepPattern] }] },
  },
  {
    files: ['test/**', 'load/**'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },
  {
    files: ['eslint.config.js'],
    ...tseslint.configs.disableTypeChecked,
  },
);
