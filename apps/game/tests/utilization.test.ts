import { describe, it, expect } from 'vitest'
import { pruneOld, fractionActive, utilizationStore } from '../src/utilizationStore.ts'

describe('fractionActive', () => {
  it('is undefined for an empty sample window (never sampled)', () => {
    expect(fractionActive([])).toBeUndefined()
  })

  it('is 1 when every sample was active', () => {
    expect(fractionActive([true, true, true])).toBe(1)
  })

  it('is 0 when every sample was idle', () => {
    expect(fractionActive([false, false])).toBe(0)
  })

  it('is the hit ratio for a mixed window', () => {
    expect(fractionActive([true, false, true, false])).toBe(0.5)
    expect(fractionActive([true, true, true, false])).toBe(0.75)
  })
})

describe('pruneOld', () => {
  it('drops samples older than the window, keeping the rest in place', () => {
    const times = [0, 10_000, 50_000, 61_000]
    const active = [true, false, true, false]
    pruneOld(times, active, 61_000, 60_000)
    // Only samples within 60s of `now` (61_000) survive: 10_000 (age 51s), 50_000 (age 11s), 61_000 (age 0).
    expect(times).toEqual([10_000, 50_000, 61_000])
    expect(active).toEqual([false, true, false])
  })

  it('is a no-op when every sample is within the window', () => {
    const times = [59_000, 60_000]
    const active = [true, false]
    pruneOld(times, active, 60_000, 60_000)
    expect(times).toEqual([59_000, 60_000])
    expect(active).toEqual([true, false])
  })

  it('empties both arrays when every sample has aged out', () => {
    const times = [0, 1000]
    const active = [true, true]
    pruneOld(times, active, 1_000_000, 60_000)
    expect(times).toEqual([])
    expect(active).toEqual([])
  })
})

describe('utilizationStore', () => {
  it('is undefined for a tile that was never sampled', () => {
    expect(utilizationStore.utilization(999)).toBeUndefined()
  })

  it('tracks a rolling fraction per tile, independent of other tiles', () => {
    utilizationStore.reset()
    utilizationStore.sample(1, true, 0)
    utilizationStore.sample(1, false, 1000)
    utilizationStore.sample(2, true, 0)
    expect(utilizationStore.utilization(1)).toBe(0.5)
    expect(utilizationStore.utilization(2)).toBe(1)
  })

  it('ages samples out of the 60s window as time passes', () => {
    utilizationStore.reset()
    utilizationStore.sample(1, false, 0)
    utilizationStore.sample(1, true, 61_000)
    // The stale (false) sample from t=0 has aged out by t=61_000, leaving only the active one.
    expect(utilizationStore.utilization(1)).toBe(1)
  })

  it('reset() clears every tile', () => {
    utilizationStore.sample(1, true, 0)
    utilizationStore.reset()
    expect(utilizationStore.utilization(1)).toBeUndefined()
  })
})
