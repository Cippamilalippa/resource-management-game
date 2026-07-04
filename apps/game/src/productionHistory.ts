/**
 * Rolling per-resource make-rate history for the production sparklines. The boot loop pushes a fresh
 * production snapshot each throttled HUD refresh; this keeps the last {@link MAX_SAMPLES} samples per
 * resource colour so the panel can draw a tiny trend line. Pure UI-side sampling off a wall-clock
 * cadence — it never reads or writes sim state, so determinism is untouched.
 */

/** One production snapshot row (only the make rate is charted). */
interface ProductionSample {
  readonly color: number
  readonly producedPerSec: number
}

/** How many recent samples each sparkline spans. */
const MAX_SAMPLES = 48

const series = new Map<number, number[]>()
const listeners = new Set<() => void>()
let version = 0

export const productionHistory = {
  /** Append the latest snapshot: every known colour advances one sample (0 when absent), so the
   * timelines stay aligned and a resource that stops producing decays visibly to zero. */
  push: (rows: readonly ProductionSample[]): void => {
    const present = new Map<number, number>()
    for (const r of rows) present.set(r.color, r.producedPerSec)
    // Ensure a series exists for any newly seen colour.
    for (const color of present.keys()) if (!series.has(color)) series.set(color, [])
    for (const [color, buf] of series) {
      buf.push(present.get(color) ?? 0)
      if (buf.length > MAX_SAMPLES) buf.shift()
    }
    version++
    for (const l of listeners) l()
  },

  /** The recent make-rate samples for a resource colour (empty when never produced). */
  series: (color: number): readonly number[] => series.get(color) ?? [],

  /** Monotonic counter bumped on every push — a stable useSyncExternalStore snapshot. */
  getVersion: (): number => version,

  subscribe: (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },

  /** Drop all history — called when a session is replaced (new game / load). */
  reset: (): void => {
    series.clear()
    version++
    for (const l of listeners) l()
  },
}
