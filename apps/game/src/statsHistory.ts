/**
 * Multi-tier per-resource production/consumption history that backs the P-screen statistics
 * dashboard ({@link ./StatsScreen.tsx}). Where {@link ./productionHistory.ts} keeps a single short
 * ring for the HUD sparklines, this module retains three downsampled windows per resource colour —
 * fine (~1 min), medium (~5 min) and coarse (~15 min) — by folding older fine samples into medium
 * samples, and older medium samples into coarse samples, so memory stays bounded regardless of how
 * long a session runs. Both the produced *and* consumed per-second rates are kept (the boot loop
 * already computes both from `productionFlows`; see main.tsx), so the screen can chart and compare
 * either series.
 *
 * Pure UI-side sampling off the wall-clock HUD refresh cadence (~4 Hz, see main.tsx) — it never
 * reads or writes sim state, so determinism is untouched. The fold math and window bookkeeping are
 * plain functions/data so they can be unit tested without any DOM or store plumbing (see
 * `apps/game/tests/statsHistory.test.ts`).
 */

/** One sampled row: a resource colour with its installed produce/consume rate this refresh. */
export interface StatFlowSample {
  readonly color: number
  readonly producedPerSec: number
  readonly consumedPerSec: number
}

/** The three retention tiers the P-screen lets the player pick between. */
export type StatsWindow = 'fine' | 'medium' | 'coarse'

/** Roughly how many wall-clock seconds a fine sample spans (matches the ~250ms HUD refresh). */
export const FINE_SAMPLE_SECONDS = 0.25
/** Fine ring capacity: 240 * 0.25s = 60s, a ~1 minute window at full resolution. */
export const FINE_CAPACITY = 240
/** Every 5 fine samples fold into one medium sample (5 * 0.25s = 1.25s per medium sample). */
export const FOLD_FINE_TO_MEDIUM = 5
/** Medium ring capacity: 240 * 1.25s = 300s, a ~5 minute window. */
export const MEDIUM_CAPACITY = 240
/** Every 4 medium samples fold into one coarse sample (4 * 1.25s = 5s per coarse sample). */
export const FOLD_MEDIUM_TO_COARSE = 4
/** Coarse ring capacity: 180 * 5s = 900s, a ~15 minute window. */
export const COARSE_CAPACITY = 180

/** Approximate wall-clock span each tier's full ring covers, for axis/label text. */
export const WINDOW_SECONDS: Record<StatsWindow, number> = {
  fine: FINE_CAPACITY * FINE_SAMPLE_SECONDS,
  medium: MEDIUM_CAPACITY * FINE_SAMPLE_SECONDS * FOLD_FINE_TO_MEDIUM,
  coarse: COARSE_CAPACITY * FINE_SAMPLE_SECONDS * FOLD_FINE_TO_MEDIUM * FOLD_MEDIUM_TO_COARSE,
}

/** Push `value` onto the end of a bounded ring, dropping the oldest sample past `capacity`. */
export function pushBounded(buf: number[], value: number, capacity: number): void {
  buf.push(value)
  if (buf.length > capacity) buf.shift()
}

/** Running sum used to average a run of samples before folding them into the coarser tier. */
export interface FoldAccumulator {
  readonly sumProduced: number
  readonly sumConsumed: number
  readonly count: number
}

export const EMPTY_ACCUMULATOR: FoldAccumulator = { sumProduced: 0, sumConsumed: 0, count: 0 }

/** Fold one more (produced, consumed) pair into the accumulator (pure — returns a new value). */
export function accumulate(
  acc: FoldAccumulator,
  produced: number,
  consumed: number,
): FoldAccumulator {
  return {
    sumProduced: acc.sumProduced + produced,
    sumConsumed: acc.sumConsumed + consumed,
    count: acc.count + 1,
  }
}

/** The accumulator's mean produced/consumed — the single downsampled sample it folds into. */
export function foldAverage(acc: FoldAccumulator): { produced: number; consumed: number } {
  if (acc.count === 0) return { produced: 0, consumed: 0 }
  return { produced: acc.sumProduced / acc.count, consumed: acc.sumConsumed / acc.count }
}

/** Arithmetic mean of a sample series (0 for an empty series, matching an idle/unseen resource). */
export function mean(series: readonly number[]): number {
  if (series.length === 0) return 0
  let sum = 0
  for (const v of series) sum += v
  return sum / series.length
}

export type Trend = 'up' | 'down' | 'flat'

/** Below this fraction of change (relative to the older half's mean) a trend reads as flat, so
 * ordinary sampling jitter on an essentially steady rate doesn't flash an arrow. */
export const TREND_EPSILON = 0.05

/**
 * Classify a series' recent direction by comparing the mean of its newer half against its older
 * half. Used for the P-screen's trend arrow (typically fed the net produced-minus-consumed series
 * for the selected window).
 */
export function trendDirection(series: readonly number[]): Trend {
  const n = series.length
  if (n < 2) return 'flat'
  const mid = Math.floor(n / 2)
  let sumOld = 0
  for (let i = 0; i < mid; i++) sumOld += series[i]!
  let sumNew = 0
  for (let i = mid; i < n; i++) sumNew += series[i]!
  const avgOld = sumOld / mid
  const avgNew = sumNew / (n - mid)
  if (avgOld === 0) return avgNew === 0 ? 'flat' : avgNew > 0 ? 'up' : 'down'
  const delta = (avgNew - avgOld) / Math.abs(avgOld)
  if (delta > TREND_EPSILON) return 'up'
  if (delta < -TREND_EPSILON) return 'down'
  return 'flat'
}

/** Per-resource ring buffers for all three tiers, plus the in-flight fold accumulators. */
interface ColorSeries {
  fineProduced: number[]
  fineConsumed: number[]
  mediumProduced: number[]
  mediumConsumed: number[]
  coarseProduced: number[]
  coarseConsumed: number[]
  fineAcc: FoldAccumulator
  mediumAcc: FoldAccumulator
}

function newColorSeries(): ColorSeries {
  return {
    fineProduced: [],
    fineConsumed: [],
    mediumProduced: [],
    mediumConsumed: [],
    coarseProduced: [],
    coarseConsumed: [],
    fineAcc: EMPTY_ACCUMULATOR,
    mediumAcc: EMPTY_ACCUMULATOR,
  }
}

/** Append one (produced, consumed) sample for a resource, folding into medium/coarse as needed. */
function pushSample(cs: ColorSeries, produced: number, consumed: number): void {
  pushBounded(cs.fineProduced, produced, FINE_CAPACITY)
  pushBounded(cs.fineConsumed, consumed, FINE_CAPACITY)
  cs.fineAcc = accumulate(cs.fineAcc, produced, consumed)
  if (cs.fineAcc.count < FOLD_FINE_TO_MEDIUM) return

  const medium = foldAverage(cs.fineAcc)
  cs.fineAcc = EMPTY_ACCUMULATOR
  pushBounded(cs.mediumProduced, medium.produced, MEDIUM_CAPACITY)
  pushBounded(cs.mediumConsumed, medium.consumed, MEDIUM_CAPACITY)
  cs.mediumAcc = accumulate(cs.mediumAcc, medium.produced, medium.consumed)
  if (cs.mediumAcc.count < FOLD_MEDIUM_TO_COARSE) return

  const coarse = foldAverage(cs.mediumAcc)
  cs.mediumAcc = EMPTY_ACCUMULATOR
  pushBounded(cs.coarseProduced, coarse.produced, COARSE_CAPACITY)
  pushBounded(cs.coarseConsumed, coarse.consumed, COARSE_CAPACITY)
}

const byColor = new Map<number, ColorSeries>()
const listeners = new Set<() => void>()
let version = 0

export const statsHistory = {
  /** Append the latest snapshot: every known colour advances one fine sample (0 when absent this
   * refresh), matching {@link productionHistory}'s decay-to-zero behaviour for a resource that
   * stops flowing. */
  push: (rows: readonly StatFlowSample[]): void => {
    const present = new Map<number, { produced: number; consumed: number }>()
    for (const r of rows)
      present.set(r.color, { produced: r.producedPerSec, consumed: r.consumedPerSec })
    for (const color of present.keys())
      if (!byColor.has(color)) byColor.set(color, newColorSeries())
    for (const [color, cs] of byColor) {
      const v = present.get(color)
      pushSample(cs, v?.produced ?? 0, v?.consumed ?? 0)
    }
    version++
    for (const l of listeners) l()
  },

  /** Every resource colour ever sampled this session (includes ones that decayed to zero). */
  colors: (): readonly number[] => [...byColor.keys()],

  producedSeries: (color: number, window: StatsWindow): readonly number[] => {
    const cs = byColor.get(color)
    if (!cs) return []
    return window === 'fine'
      ? cs.fineProduced
      : window === 'medium'
        ? cs.mediumProduced
        : cs.coarseProduced
  },

  consumedSeries: (color: number, window: StatsWindow): readonly number[] => {
    const cs = byColor.get(color)
    if (!cs) return []
    return window === 'fine'
      ? cs.fineConsumed
      : window === 'medium'
        ? cs.mediumConsumed
        : cs.coarseConsumed
  },

  /** Monotonic counter bumped on every push — a stable useSyncExternalStore snapshot. */
  getVersion: (): number => version,

  subscribe: (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },

  /** Drop all history — called when a session is replaced (new game / load). */
  reset: (): void => {
    byColor.clear()
    version++
    for (const l of listeners) l()
  },
}
