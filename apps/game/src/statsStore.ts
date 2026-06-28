/**
 * Tiny external store bridging the per-frame render loop to React. The loop writes
 * a fresh snapshot (throttled), React reads it via useSyncExternalStore. Keeps the
 * sim/render loop fully decoupled from React's render cadence.
 */
export interface Stats {
  tick: number
  entities: number
  prototypes: number
  mods: string
  fps: number
}

let state: Stats = { tick: 0, entities: 0, prototypes: 0, mods: '—', fps: 0 }
const listeners = new Set<() => void>()

export const statsStore = {
  get: (): Stats => state,
  set: (next: Stats): void => {
    state = next
    for (const l of listeners) l()
  },
  subscribe: (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
}
