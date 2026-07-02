/**
 * UI-side store for sim playback controls: paused state and speed multiplier. Like the other
 * tiny external stores, React reads it via useSyncExternalStore. It holds *intent* only — the
 * boot loop (main.tsx) polls it each frame and decides whether to advance the scheduler and by
 * how much real time (speed scales the frame delta fed to the fixed-timestep scheduler, so the
 * sim stays deterministic — it just runs more or fewer fixed ticks per real second). Pausing here
 * is independent of the save menu, which also freezes the sim while it is open.
 */

/** Selectable speed multipliers, slowest → fastest. 1× is real time. */
export const SIM_SPEEDS = [0.5, 1, 2, 4] as const

export interface SimControlState {
  readonly paused: boolean
  /** Real-time multiplier applied to the frame delta before advancing the scheduler. */
  readonly speed: number
}

let state: SimControlState = { paused: false, speed: 1 }
const listeners = new Set<() => void>()

function set(next: SimControlState): void {
  state = next
  for (const l of listeners) l()
}

export const simControlStore = {
  get: (): SimControlState => state,
  subscribe: (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  setPaused: (paused: boolean): void => set({ ...state, paused }),
  togglePause: (): void => set({ ...state, paused: !state.paused }),
  /** Set the speed multiplier (unpauses — choosing a speed implies "run"). */
  setSpeed: (speed: number): void => set({ paused: false, speed }),
  /** Step to the next speed in {@link SIM_SPEEDS}, wrapping; unpauses. */
  cycleSpeed: (): void => {
    const i = SIM_SPEEDS.indexOf(state.speed as (typeof SIM_SPEEDS)[number])
    const next = SIM_SPEEDS[(i + 1) % SIM_SPEEDS.length]!
    set({ paused: false, speed: next })
  },
}
