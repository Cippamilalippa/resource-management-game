/**
 * UI-side store for the G5 win screen. The boot loop (main.tsx) watches the sim-side `goalStatus`
 * selector each throttled refresh; the first time the goal flips to reached *within this app
 * session*, it captures a frozen {@link VictoryStats} snapshot and opens the modal here. A session
 * that LOADS an already-won world sets `won` (so the persistent TopBar badge shows) but never opens
 * the modal — you don't get a fresh fanfare for a victory you already had.
 *
 * Read-only with respect to the sim: this holds nothing but a display snapshot and two flags. It
 * never touches the world, so it cannot affect determinism.
 */

/** One settlement's standing on the win screen: its name and how far up its ladder it climbed. */
export interface VictorySettlement {
  readonly name: string
  /** Human level (stage + 1). */
  readonly level: number
  /** Top level the ladder offers (maxStage + 1). */
  readonly maxLevel: number
}

/** The frozen end-of-run summary the win screen renders (captured the moment the goal is reached). */
export interface VictoryStats {
  /** Wall-clock seconds actually spent advancing the sim this session. */
  readonly playTimeSec: number
  /** Simulation ticks elapsed. */
  readonly ticks: number
  /** Technologies researched at runtime (earned, not the seeded roots). */
  readonly techNames: readonly string[]
  /** Every settlement's level standing. */
  readonly settlements: readonly VictorySettlement[]
  /** Total installed production throughput, units per second (a cheap headline figure). */
  readonly totalProducedPerSec: number
  /** Number of crafting machines built. */
  readonly machineCount: number
  /** Display name of the goal settlement. */
  readonly goalName: string
  /** The required stage index the goal asked for. */
  readonly goalStage: number
}

/** The win-screen state: whether the run is won, whether the modal is up, and the frozen stats. */
export interface VictoryState {
  /** True once the goal has been reached this session (drives the persistent TopBar badge). */
  readonly won: boolean
  /** Whether the celebratory modal is currently on screen. */
  readonly modalOpen: boolean
  /** The frozen end-of-run summary, or null before a win is captured. */
  readonly stats: VictoryStats | null
}

const initial: VictoryState = { won: false, modalOpen: false, stats: null }

let state: VictoryState = initial
const listeners = new Set<() => void>()

export const victoryStore = {
  get: (): VictoryState => state,
  set: (next: Partial<VictoryState>): void => {
    state = { ...state, ...next }
    for (const l of listeners) l()
  },
  /** Reset to the un-won state — called when a fresh session starts before its goal is evaluated. */
  reset: (): void => {
    state = initial
    for (const l of listeners) l()
  },
  subscribe: (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
}
