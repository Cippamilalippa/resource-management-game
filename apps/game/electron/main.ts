import { app, BrowserWindow, ipcMain } from 'electron'
import { basename, join, resolve } from 'node:path'
import { PrototypeRegistry } from '@factory/engine/data'
import { discoverModSources, readManifest, loadMods } from '@factory/engine/modloader'

// The Electron main is bundled to CommonJS (dist-electron/main.cjs), so __dirname
// is available natively — no import.meta.url (which would be empty under CJS).
const here = __dirname
const DEV_URL = process.env.VITE_DEV_SERVER_URL

/** Absolute path to the repo's /mods directory (the base game lives in mods/base). */
function modsDir(): string {
  // dist-electron/ -> apps/game/ -> apps/ -> repo root -> mods
  return resolve(here, '../../../mods')
}

/**
 * Load the base game through the REAL mod loader path (the renderer has no fs
 * access, so the main process does it and hands the merged data over via IPC).
 * Every mod under /mods is discovered the same way — mods/base is not special.
 */
ipcMain.handle('factory:loadContent', async () => {
  const registry = new PrototypeRegistry()
  const sources = await discoverModSources(modsDir())
  // Read every manifest here (in the fs-capable main process), then merge prototypes.
  // The renderer can't touch disk, so it receives the manifests it needs to RUN the
  // mods' scripts — script execution itself happens renderer-side, where the sim lives.
  const discovered = await Promise.all(sources.map(readManifest))
  const load = await loadMods(discovered, registry)
  return {
    mods: load.order.map((m) => ({ id: m.id, version: m.version })),
    // Each mod's manifest (carries its script paths + dependency order) plus the
    // basename of its source directory, which keys the renderer's bundled-script lookup.
    // `sources[i]` is the NodeFileSource `discovered[i]` was read from (same order).
    discovered: discovered.map((d, i) => ({
      dir: basename(sources[i]!.root),
      manifest: d.manifest,
    })),
    prototypeCount: load.prototypeCount,
    prototypes: registry.list(),
  }
})

async function createWindow(): Promise<void> {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: '#12141c',
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (DEV_URL) {
    await win.loadURL(DEV_URL)
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    await win.loadFile(join(here, '../dist/index.html'))
  }
}

void app.whenReady().then(async () => {
  await createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
