// Builds the Electron main + preload from TypeScript to CommonJS bundles in
// dist-electron/. Kept separate from the Vite renderer build. esbuild bundles the
// engine (TS workspace package) in, and leaves `electron` external.
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = resolve(here, '..')

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outExtension: { '.js': '.cjs' },
  external: ['electron'],
  sourcemap: true,
  logLevel: 'info',
}

await Promise.all([
  build({
    ...common,
    entryPoints: [resolve(appRoot, 'electron/main.ts')],
    outfile: resolve(appRoot, 'dist-electron/main.cjs'),
  }),
  build({
    ...common,
    entryPoints: [resolve(appRoot, 'electron/preload.ts')],
    outfile: resolve(appRoot, 'dist-electron/preload.cjs'),
  }),
])
