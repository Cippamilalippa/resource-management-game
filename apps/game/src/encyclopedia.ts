/**
 * In-game recipe encyclopedia: a read-only, searchable catalogue derived once from the loaded
 * machine/recipe metadata ({@link MachineIndex}). It lets the player plan a production chain without
 * leaving the game — "what makes X, from what, in which machine, how fast". Pure data + UI state; it
 * never reads or writes sim state, so determinism is untouched.
 */
import type { MachineIndex } from './machines.ts'

/** One catalogue row: a recipe with the machine that runs it, resolved to resource colours. */
export interface EncyclopediaEntry {
  readonly id: string
  readonly name: string
  readonly machineName: string
  readonly category: string
  /** Ticks per craft. */
  readonly craftEvery: number
  readonly inputs: readonly EncyclopediaFlow[]
  readonly outputs: readonly EncyclopediaFlow[]
}

/** A recipe flow with its identity colour, per-craft amount, and per-minute throughput. */
export interface EncyclopediaFlow {
  readonly color: number
  readonly amount: number
  /** Units per minute this flow runs at, for the machine that hosts the recipe. */
  readonly perMin: number
}

/** Build the catalogue from the derived machine index: one entry per (machine, recipe) it can run. */
export function buildEncyclopedia(machines: MachineIndex): EncyclopediaEntry[] {
  const entries: EncyclopediaEntry[] = []
  for (const def of machines.defs) {
    for (const r of def.recipes) {
      entries.push({
        id: `${def.id}:${r.id}`,
        name: r.name,
        machineName: def.name,
        category: r.category,
        craftEvery: r.craftEvery,
        inputs: r.inputs.map((f, i) => ({
          color: f.color,
          amount: f.amount,
          perMin: r.inputRates[i] ?? 0,
        })),
        outputs: r.outputs.map((f, i) => ({
          color: f.color,
          amount: f.amount,
          perMin: r.outputRates[i] ?? 0,
        })),
      })
    }
  }
  // Stable A→Z by product name so the list reads predictably.
  entries.sort((a, b) => a.name.localeCompare(b.name))
  return entries
}

interface EncyclopediaState {
  readonly entries: readonly EncyclopediaEntry[]
  readonly open: boolean
}

let state: EncyclopediaState = { entries: [], open: false }
const listeners = new Set<() => void>()

function set(next: EncyclopediaState): void {
  state = next
  for (const l of listeners) l()
}

export const encyclopediaStore = {
  get: (): EncyclopediaState => state,
  subscribe: (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  /** Load the catalogue for the current session (called at boot from the derived machine index). */
  setEntries: (entries: readonly EncyclopediaEntry[]): void => set({ ...state, entries }),
  toggle: (): void => set({ ...state, open: !state.open }),
  close: (): void => set({ ...state, open: false }),
}
