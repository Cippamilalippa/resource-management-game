/**
 * UI toggle for the full-screen map view (Factorio's M). When on, the renderer hides the world and
 * draws a full-viewport overview from live entity positions (see `Renderer.setMapMode`); the boot
 * loop mirrors this flag onto the renderer and suppresses the corner minimap / edge-scroll while it
 * is up. Holds view intent only — never sim state, so it can't affect determinism.
 */
interface MapModeState {
  readonly on: boolean
}

let state: MapModeState = { on: false }
const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) l()
}

export const mapModeStore = {
  get: (): MapModeState => state,
  subscribe: (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  toggle: (): void => {
    state = { on: !state.on }
    emit()
  },
  /** Force the map on/off (e.g. the boot loop closing it when a modal opens). No-op if unchanged. */
  set: (on: boolean): void => {
    if (state.on === on) return
    state = { on }
    emit()
  },
}
