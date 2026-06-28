import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'
import globals from 'globals'

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/dist-electron/**',
      '**/release/**',
      '**/coverage/**',
      '**/*.tsbuildinfo',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  // The seeded-RNG / determinism rule: the engine sim must never touch wall-clock
  // time or the global PRNG. Render/UI code is exempt (it is allowed to read time).
  {
    files: ['packages/engine/core/**/*.ts', 'content/scripts/**/*.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'Sim code must use the seeded RNG.' },
        {
          object: 'Date',
          property: 'now',
          message: 'Sim code must be deterministic; no Date.now.',
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'Date', message: 'Sim code must be deterministic; no Date in core.' },
      ],
    },
  },
  prettier,
)
