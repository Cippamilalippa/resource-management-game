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
  /** Lucide icon name (PascalCase) from the prototype; UI falls back per-kind when absent. */
  readonly icon?: string
  readonly w: number
  readonly h: number
  /** Track/footprint color. */
  readonly color: number
  /** Resource colour a producer makes (producers only; ignored otherwise). */
  readonly itemColor: number
  /** Resource colours a building stockpiles from input ports (buildings only). */
  readonly accepts: readonly number[]
  /** Ticks between drains for an output port. */
  readonly spawnEvery: number
  /** Ticks between item advances for a belt. */
  readonly moveEvery: number
  /** Ticks between items a production building makes (producers only). */
  readonly produceEvery: number
  /** Per-resource stockpile cap of a building/producer. */
  readonly storage: number
  /**
   * Terrain prototype id this producer must be built on (producers only); absent for a
   * producer that may sit on any belt tile. Drives the placement validity check.
   */
  readonly requiresTerrain?: string
}

export interface BuildState {
  readonly items: readonly BuildItem[]
  /** Id of the selected tool, or null when nothing is selected. */
  readonly selected: string | null
  /** The delete tool is armed: clicking a tile removes the deletable object on it. */
  readonly deleting: boolean
}

let state: BuildState = { items: [], selected: null, deleting: false }
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
  /** Toggle a tool: re-selecting the active tool deselects it. Arming a tool disarms delete. */
  toggle: (id: string): void =>
    set({ ...state, selected: state.selected === id ? null : id, deleting: false }),
  /** Arm/disarm the delete tool; arming it clears any selected build tool. */
  toggleDelete: (): void => set({ ...state, deleting: !state.deleting, selected: null }),
  /** Disarm everything (build tool and delete) — returns to inspect mode. */
  clearSelection: (): void => set({ ...state, selected: null, deleting: false }),
  selectedItem: (): BuildItem | null =>
    state.selected ? (state.items.find((i) => i.id === state.selected) ?? null) : null,
}
