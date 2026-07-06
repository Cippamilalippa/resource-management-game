import { describe, it, expect, beforeEach } from 'vitest'
import {
  statsHistory,
  pushBounded,
  accumulate,
  foldAverage,
  mean,
  trendDirection,
  EMPTY_ACCUMULATOR,
  FOLD_FINE_TO_MEDIUM,
  FOLD_MEDIUM_TO_COARSE,
  FINE_CAPACITY,
} from '../src/statsHistory.ts'

/**
 * The P-screen statistics history keeps three downsampled tiers (fine/medium/coarse) per resource
 * colour by folding runs of finer samples into an average as they age out. These tests pin the pure
 * fold math in isolation, then the end-to-end tier bookkeeping (fold cadence, ring capacity, the
 * decay-to-zero alignment `productionHistory` already relies on) without any DOM or wall clock.
 */
describe('pushBounded', () => {
  it('appends and drops the oldest sample once past capacity', () => {
    const buf: number[] = []
    pushBounded(buf, 1, 3)
    pushBounded(buf, 2, 3)
    pushBounded(buf, 3, 3)
    expect(buf).toEqual([1, 2, 3])
    pushBounded(buf, 4, 3)
    expect(buf).toEqual([2, 3, 4])
  })
})

describe('accumulate / foldAverage', () => {
  it('averages the accumulated produced/consumed pairs', () => {
    let acc = EMPTY_ACCUMULATOR
    acc = accumulate(acc, 10, 2)
    acc = accumulate(acc, 20, 4)
    expect(acc.count).toBe(2)
    expect(foldAverage(acc)).toEqual({ produced: 15, consumed: 3 })
  })

  it('is zero for an empty accumulator (no divide-by-zero)', () => {
    expect(foldAverage(EMPTY_ACCUMULATOR)).toEqual({ produced: 0, consumed: 0 })
  })
})

describe('mean', () => {
  it('averages a series and is 0 for an empty one', () => {
    expect(mean([1, 2, 3])).toBe(2)
    expect(mean([])).toBe(0)
  })
})

describe('trendDirection', () => {
  it('flat for fewer than two samples', () => {
    expect(trendDirection([])).toBe('flat')
    expect(trendDirection([5])).toBe('flat')
  })

  it('up when the newer half clearly exceeds the older half', () => {
    expect(trendDirection([1, 1, 5, 5])).toBe('up')
  })

  it('down when the newer half clearly trails the older half', () => {
    expect(trendDirection([5, 5, 1, 1])).toBe('down')
  })

  it('flat when the change is within the jitter epsilon', () => {
    expect(trendDirection([10, 10, 10.1, 10.1])).toBe('flat')
  })

  it('handles a zero older-half mean without dividing by zero', () => {
    expect(trendDirection([0, 0, 0, 0])).toBe('flat')
    expect(trendDirection([0, 0, 5, 5])).toBe('up')
  })
})

describe('statsHistory', () => {
  beforeEach(() => statsHistory.reset())

  it('advances every known colour each push, decaying an absent colour to zero (fine tier)', () => {
    statsHistory.push([{ color: 1, producedPerSec: 5, consumedPerSec: 1 }])
    statsHistory.push([{ color: 2, producedPerSec: 3, consumedPerSec: 0 }])
    expect(statsHistory.producedSeries(1, 'fine')).toEqual([5, 0])
    expect(statsHistory.consumedSeries(1, 'fine')).toEqual([1, 0])
    expect(statsHistory.producedSeries(2, 'fine')).toEqual([3])
    expect(statsHistory.colors()).toEqual(expect.arrayContaining([1, 2]))
  })

  it('folds every N fine samples into one medium sample, averaged', () => {
    expect(FOLD_FINE_TO_MEDIUM).toBe(5)
    for (let i = 1; i <= 5; i++) {
      statsHistory.push([{ color: 7, producedPerSec: i, consumedPerSec: i * 2 }])
    }
    // Average of 1..5 = 3; average of 2,4,6,8,10 = 6.
    expect(statsHistory.producedSeries(7, 'medium')).toEqual([3])
    expect(statsHistory.consumedSeries(7, 'medium')).toEqual([6])
    // The medium tier only gains a sample once the fold cadence completes.
    for (let i = 0; i < FOLD_FINE_TO_MEDIUM - 1; i++) {
      statsHistory.push([{ color: 7, producedPerSec: 100, consumedPerSec: 0 }])
    }
    expect(statsHistory.producedSeries(7, 'medium')).toEqual([3])
  })

  it('folds medium into coarse after the full fine→medium→coarse cadence', () => {
    const totalFine = FOLD_FINE_TO_MEDIUM * FOLD_MEDIUM_TO_COARSE
    for (let i = 0; i < totalFine; i++) {
      statsHistory.push([{ color: 9, producedPerSec: 10, consumedPerSec: 1 }])
    }
    expect(statsHistory.producedSeries(9, 'medium')).toEqual([10, 10, 10, 10])
    expect(statsHistory.producedSeries(9, 'coarse')).toEqual([10])
    expect(statsHistory.consumedSeries(9, 'coarse')).toEqual([1])
  })

  it('bounds the fine ring at its capacity', () => {
    for (let i = 0; i < FINE_CAPACITY + 10; i++) {
      statsHistory.push([{ color: 3, producedPerSec: i, consumedPerSec: 0 }])
    }
    const series = statsHistory.producedSeries(3, 'fine')
    expect(series.length).toBe(FINE_CAPACITY)
    // The oldest 10 samples (0..9) should have rolled off; the ring ends at the latest push.
    expect(series[series.length - 1]).toBe(FINE_CAPACITY + 9)
  })

  it('an unknown colour reports empty series at every tier', () => {
    expect(statsHistory.producedSeries(42, 'fine')).toEqual([])
    expect(statsHistory.producedSeries(42, 'medium')).toEqual([])
    expect(statsHistory.producedSeries(42, 'coarse')).toEqual([])
  })

  it('bumps the version on push and reset, and reset clears every tier', () => {
    const v0 = statsHistory.getVersion()
    statsHistory.push([{ color: 1, producedPerSec: 1, consumedPerSec: 1 }])
    expect(statsHistory.getVersion()).toBeGreaterThan(v0)
    const v1 = statsHistory.getVersion()
    statsHistory.reset()
    expect(statsHistory.getVersion()).toBeGreaterThan(v1)
    expect(statsHistory.colors()).toEqual([])
    expect(statsHistory.producedSeries(1, 'fine')).toEqual([])
  })

  it('notifies subscribers on push', () => {
    let calls = 0
    const unsub = statsHistory.subscribe(() => calls++)
    statsHistory.push([{ color: 1, producedPerSec: 1, consumedPerSec: 0 }])
    expect(calls).toBe(1)
    unsub()
    statsHistory.push([{ color: 1, producedPerSec: 1, consumedPerSec: 0 }])
    expect(calls).toBe(1)
  })
})
