/**
 * UI-side store for the build bar: the placeable things and the currently selected
 * tool. Like {@link statsStore} it is a tiny external store React reads via
 * useSyncExternalStore, keeping the Pixi/React layers decoupled. It holds *intent*
 * only — placing actually happens through the sim command queue, never by mutating
 * sim state here. (The in-progress belt drag is transient gesture state owned by
 * `placement.ts`, not stored here.)
 */
export interface BuildItem {
  readonly id: string
  readonly name: string
  readonly kind: 'building' | 'belt' | 'port' | 'splitter' | 'producer'
  /** Which port a 'port' tool places; undefined for other kinds. */
  readonly port?: 'input' | 'output'
  readonly w: number
  readonly h: number
  /** Track/footprint color. */
  readonly color: number
  /** Color of the item an output port extracts / a producer makes (ignored otherwise). */
  readonly itemColor: number
  /** Ticks between extractions for an output port. */
  readonly spawnEvery: number
  /** Ticks between item advances for a belt. */
  readonly moveEvery: number
  /** Ticks between items a production building makes (producers only). */
  readonly produceEvery: number
  /** Internal store size of a production building (producers only). */
  readonly storage: number
}

export interface BuildState {
  readonly items: readonly BuildItem[]
  /** Id of the selected tool, or null when nothing is selected. */
  readonly selected: string | null
}

let state: BuildState = { items: [], selected: null }
const listeners = new Set<() => void>()

function set(next: BuildState): void {
  state = next
  for (const l of listeners) l()
}

export const buildStore = {
  get: (): BuildState => state,
  subscribe: (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  setItems: (items: readonly BuildItem[]): void => set({ ...state, items }),
  /** Toggle a tool: re-selecting the active tool deselects it. */
  toggle: (id: string): void => set({ ...state, selected: state.selected === id ? null : id }),
  clearSelection: (): void => set({ ...state, selected: null }),
  selectedItem: (): BuildItem | null =>
    state.selected ? (state.items.find((i) => i.id === state.selected) ?? null) : null,
}
