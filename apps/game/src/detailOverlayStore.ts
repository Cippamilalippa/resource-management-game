/**
 * UI toggle for the on-map detail overlay ("alt-mode", Factorio's Alt key): when on, the boot loop
 * feeds the renderer a per-object annotation set (each crafter's product glyph, a warn marker on
 * unconfigured machines, port filter-colour chips) so the whole factory reads at a glance. Holds
 * view intent only — never sim state.
 *
 * The choice is persisted to `localStorage` (most players leave alt-mode on forever), and defaults
 * to ON for a first run so a fresh factory is legible out of the box.
 */
const STORAGE_KEY = 'factory.detailOverlay'

interface DetailOverlayState {
  readonly on: boolean
}

/** Read the persisted preference; defaults to ON when unset (or storage is unavailable). */
function read(): boolean {
  try {
    const v = globalThis.localStorage?.getItem(STORAGE_KEY)
    return v === null || v === undefined ? true : v === '1'
  } catch {
    return true
  }
}

let state: DetailOverlayState = { on: read() }
const listeners = new Set<() => void>()

export const detailOverlayStore = {
  get: (): DetailOverlayState => state,
  subscribe: (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  toggle: (): void => {
    state = { on: !state.on }
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, state.on ? '1' : '0')
    } catch {
      // Ignore storage failures — the toggle still applies for the session.
    }
    for (const l of listeners) l()
  },
}
