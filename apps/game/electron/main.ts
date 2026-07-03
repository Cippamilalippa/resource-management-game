import { app, BrowserWindow, ipcMain } from 'electron'
import { basename, join, resolve } from 'node:path'
import { PrototypeRegistry } from '@factory/engine/data'
import { readManifest, loadMods } from '@factory/engine/modloader'
import { discoverModSources } from '@factory/engine/modloader/node'
import { listSaves, saveGame, loadGame, deleteSave, renameSave } from './saves.ts'
import type { SaveRequest } from './saveTypes.ts'

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

// Save/load lives in the main process because the sandboxed renderer has no fs access. It
// hands us an opaque engine snapshot to persist and asks us to enumerate/restore/delete slots;
// see electron/saves.ts for the slot model (manual / quick / auto).
ipcMain.handle('factory:listSaves', () => listSaves())
ipcMain.handle('factory:saveGame', (_e, req: SaveRequest) => saveGame(req))
ipcMain.handle('factory:loadGame', (_e, id: string) => loadGame(id))
ipcMain.handle('factory:deleteSave', (_e, id: string) => deleteSave(id))
ipcMain.handle('factory:renameSave', (_e, id: string, name: string) => renameSave(id, name))
// Quit from the main menu. Fire-and-forget on the renderer side; the app tears down here.
ipcMain.handle('factory:quit', () => app.quit())

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
