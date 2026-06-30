import { contextBridge, ipcRenderer } from 'electron'
import type { ModManifest } from '@factory/engine/modloader'

/** A discovered mod as handed to the renderer: its validated manifest (script paths +
 *  dependency order) and the basename of its source directory (keys the renderer's
 *  bundled-script lookup, since the renderer has no disk access). */
export interface DiscoveredModInfo {
  dir: string
  manifest: ModManifest
}

/**
 * The bridge between the (sandboxed) renderer and the main process. The renderer
 * asks the main process to load /content through the mod loader and receives the
 * merged prototype data back, plus the manifests it needs to RUN each mod's scripts
 * (script execution happens renderer-side, where the sim lives).
 */
export interface LoadedContent {
  mods: { id: string; version: string }[]
  discovered: DiscoveredModInfo[]
  prototypeCount: number
  prototypes: Array<Record<string, unknown> & { id: string; type: string }>
}

const api = {
  loadContent: (): Promise<LoadedContent> => ipcRenderer.invoke('factory:loadContent'),
}

contextBridge.exposeInMainWorld('factory', api)

export type FactoryBridge = typeof api
