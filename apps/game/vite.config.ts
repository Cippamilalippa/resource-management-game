import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Renderer-only Vite config. The Electron main/preload are built separately with
// esbuild (see scripts/build-electron.mjs). `base: './'` makes the production
// build load correctly from the file:// protocol inside Electron.
export default defineConfig({
  root: import.meta.dirname,
  base: './',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
