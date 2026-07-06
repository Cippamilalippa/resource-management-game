/**
 * Rolling per-crafter utilization history for the inspector's "Utilization (60s)" readout. Each
 * throttled HUD refresh (~4 Hz, see `main.tsx`/`placement.ts`) samples whether the *currently
 * inspected* crafter fired this refresh (`RenderHints.active`, a transient sim→render flag — see
 * `packages/engine/core/components.ts`), keyed by its footprint tile so re-selecting the same
 * building later resumes its own window instead of starting fresh. Samples older than the window
 * are pruned on each push. Pure UI-side, wall-clock-timestamped sampling — it only *reads* sim
 * state (never mutates it) and never touches the sim clock, so determinism is untouched.
 */

/** How far back the utilization fraction looks. */
const WINDOW_MS = 60_000

interface Bucket {
  /** Parallel to `times`: whether the crafter was active on that sample. */
  readonly active: boolean[]
  /** Wall-clock timestamp (ms) of each sample, oldest first. */
  readonly times: number[]
}

/** Drop samples older than `windowMs` before `now` from the front of the (time-ordered) buffers. */
export function pruneOld(times: number[], active: boolean[], now: number, windowMs: number): void {
  let i = 0
  while (i < times.length && now - times[i]! > windowMs) i++
  if (i > 0) {
    times.splice(0, i)
    active.splice(0, i)
  }
}

/** Fraction of `samples` that are `true`, or `undefined` for an empty window (nothing sampled yet). */
export function fractionActive(samples: readonly boolean[]): number | undefined {
  if (samples.length === 0) return undefined
  let hits = 0
  for (const s of samples) if (s) hits++
  return hits / samples.length
}

const byTile = new Map<number, Bucket>()

export const utilizationStore = {
  /** Record one wall-clock sample of whether the crafter at `tile` was active. */
  sample(tile: number, active: boolean, now: number = Date.now()): void {
    let b = byTile.get(tile)
    if (!b) {
      b = { active: [], times: [] }
      byTile.set(tile, b)
    }
    b.active.push(active)
    b.times.push(now)
    pruneOld(b.times, b.active, now, WINDOW_MS)
  },

  /** Fraction of recorded samples (within the last {@link WINDOW_MS}) where `tile` was active. */
  utilization(tile: number): number | undefined {
    const b = byTile.get(tile)
    return b ? fractionActive(b.active) : undefined
  },

  /** Drop all history — called when a session is replaced (new game / load). */
  reset(): void {
    byTile.clear()
  },
}
