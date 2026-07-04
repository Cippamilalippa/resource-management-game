/**
 * UI toggle for the on-map status overlay: when on, the boot loop feeds the renderer a tinted marker
 * per flagged tile (starved crafters, backed-up outputs, declining villages) read from the same
 * read-only HUD alert selector the alert stack uses. Holds view intent only — never sim state.
 */
interface OverlayState {
  readonly on: boolean
}

let state: OverlayState = { on: false }
const listeners = new Set<() => void>()

export const overlayStore = {
  get: (): OverlayState => state,
  subscribe: (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  toggle: (): void => {
    state = { on: !state.on }
    for (const l of listeners) l()
  },
}
