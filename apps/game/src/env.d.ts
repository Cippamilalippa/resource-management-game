import type { FactoryBridge } from '../electron/preload.ts'

declare global {
  interface Window {
    /** Bridge injected by the Electron preload. Absent when run in a plain browser. */
    factory?: FactoryBridge
  }
}

export {}
