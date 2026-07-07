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
  /** Recipe inputs a crafter consumes per craft (producer tools only; empty for extraction). */
  readonly craftInputs?: readonly { color: number; amount: number }[]
  /** Recipe outputs a crafter produces per craft (producer tools only). */
  readonly craftOutputs?: readonly { color: number; amount: number }[]
  /** Resource colours a building stockpiles from input ports (buildings only). */
  readonly accepts: readonly number[]
  /** Building tool only: register the placed store as a research lab (its packs drive research). */
  readonly researchLab?: boolean
  /** Building tool only: register the placed store as a treasury depot (belted goods refill the bank). */
  readonly depot?: boolean
  /**
   * Build cost charged from the treasury to place one of these (resolved to resource colours). For a
   * belt this is the *per-tile* cost — the placement path multiplies it by the drawn run length.
   * Empty/omitted means free.
   */
  readonly cost?: readonly { readonly color: number; readonly amount: number }[]
  /** Per-cadence upkeep in credits drained while the building stands (0/omitted = free to run). */
  readonly upkeep?: number
  /** True when the unlocking technology is not yet researched — shown greyed and not selectable. */
  readonly locked?: boolean
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
  /**
   * True when this producer is an extraction machine (mine / derrick): its recipe is picked
   * automatically from the terrain it sits on, so it can only be placed on a matching deposit
   * and never offers a manual recipe choice.
   */
  readonly extraction?: boolean
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
  /** Select a tool outright (never a toggle-off) — used by the Q pick tool. Disarms delete. */
  select: (id: string): void => set({ ...state, selected: id, deleting: false }),
  /** Arm/disarm the delete tool; arming it clears any selected build tool. */
  toggleDelete: (): void => set({ ...state, deleting: !state.deleting, selected: null }),
  /** Disarm everything (build tool and delete) — returns to inspect mode. */
  clearSelection: (): void => set({ ...state, selected: null, deleting: false }),
  selectedItem: (): BuildItem | null =>
    state.selected ? (state.items.find((i) => i.id === state.selected) ?? null) : null,
}
