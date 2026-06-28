import { contextBridge, ipcRenderer } from 'electron'

/**
 * The bridge between the (sandboxed) renderer and the main process. The renderer
 * asks the main process to load /content through the mod loader and receives the
 * merged prototype data back.
 */
export interface LoadedContent {
  mods: { id: string; version: string }[]
  prototypeCount: number
  prototypes: Array<Record<string, unknown> & { id: string; type: string }>
}

const api = {
  loadContent: (): Promise<LoadedContent> => ipcRenderer.invoke('factory:loadContent'),
}

contextBridge.exposeInMainWorld('factory', api)

export type FactoryBridge = typeof api
