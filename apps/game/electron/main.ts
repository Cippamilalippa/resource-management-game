import { app, BrowserWindow, ipcMain } from 'electron'
import { join, resolve } from 'node:path'
import { PrototypeRegistry } from '@factory/engine/data'
import { NodeFileSource, discoverAndLoad } from '@factory/engine/modloader'

// The Electron main is bundled to CommonJS (dist-electron/main.cjs), so __dirname
// is available natively — no import.meta.url (which would be empty under CJS).
const here = __dirname
const DEV_URL = process.env.VITE_DEV_SERVER_URL

/** Absolute path to the repo's /content directory ("mod zero"). */
function contentDir(): string {
  // dist-electron/ -> apps/game/ -> apps/ -> repo root -> content
  return resolve(here, '../../../content')
}

/**
 * Load the base game through the REAL mod loader path (the renderer has no fs
 * access, so the main process does it and hands the merged data over via IPC).
 */
ipcMain.handle('factory:loadContent', async () => {
  const registry = new PrototypeRegistry()
  const source = new NodeFileSource(contentDir())
  const load = await discoverAndLoad([source], registry)
  return {
    mods: load.order.map((m) => ({ id: m.id, version: m.version })),
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
