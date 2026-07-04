/**
 * UI-side store for the port colour-filter editor shown in the inspector sidebar. When the player
 * pins an input/output port (clicks it), `placement.ts` publishes the port's live filter here; the
 * {@link FilterPanel} reads it via useSyncExternalStore and calls back through the
 * {@link FilterController} (wired by `placement.ts`, which owns the world) to enqueue a
 * `set_port_filter` command. Cleared whenever the pin is released or a non-port is selected.
 *
 * Mirrors {@link ./recipeStore.ts} — the same pattern the recipe picker uses, so the two sidebar
 * editors behave identically (intent flows UI → store → host, the host owns the sim).
 */
export interface FilterSelection {
  readonly x: number
  readonly y: number
  /** Which kind of port is pinned (affects the wording only — both filter the same way). */
  readonly port: 'input' | 'output'
  /** Current filter mode: FILTER_NONE | FILTER_WHITELIST | FILTER_BLACKLIST. */
  readonly mode: number
  /** The port's current filtered colours (empty when unfiltered). */
  readonly colors: readonly number[]
}

export interface FilterController {
  /** Apply a filter to the pinned port (enqueues set_port_filter). */
  set(mode: number, colors: readonly number[]): void
}

let selection: FilterSelection | null = null
let controller: FilterController | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) l()
}

export const filterStore = {
  get: (): FilterSelection | null => selection,
  set: (next: FilterSelection | null): void => {
    selection = next
    emit()
  },
  subscribe: (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  setController: (c: FilterController): void => {
    controller = c
  },
  getController: (): FilterController | null => controller,
}
