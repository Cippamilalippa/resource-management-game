import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Tests live in a `tests/` folder within each package/app, never beside source.
    include: ['packages/**/tests/**/*.test.ts', 'apps/**/tests/**/*.test.ts'],
    environment: 'node',
  },
})
