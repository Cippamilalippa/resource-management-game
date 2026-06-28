import { describe, it, expect } from 'vitest'
import { createGameWorld, spawnEntity, Scheduler, counterSystem } from './index.ts'
import { hashState } from '../persistence/index.ts'

/** Build a world and populate it deterministically from its seeded RNG. */
function seededWorld(seed: number) {
  const gw = createGameWorld(seed)
  for (let i = 0; i < 50; i++) {
    spawnEntity(gw, {
      pos: { x: gw.rng.nextInt(-50, 50), y: gw.rng.nextInt(-50, 50) },
      color: 0x4fa8ff,
    })
  }
  return gw
}

describe('Scheduler', () => {
  it('advances exactly N ticks and runs systems each tick', () => {
    const gw = seededWorld(1)
    const scheduler = new Scheduler([counterSystem], { tickRate: 60 })
    scheduler.runTicks(gw, 100)
    expect(gw.tick).toBe(100)
    expect(gw.stats.systemRuns).toBe(100)
  })

  it('is deterministic: same seed + tick count -> identical state hash', () => {
    const a = seededWorld(1234)
    const b = seededWorld(1234)
    const scheduler = new Scheduler([counterSystem])
    scheduler.runTicks(a, 250)
    scheduler.runTicks(b, 250)
    expect(hashState(a)).toBe(hashState(b))
  })

  it('different seeds diverge', () => {
    const a = seededWorld(1)
    const b = seededWorld(2)
    expect(hashState(a)).not.toBe(hashState(b))
  })

  it('accumulator runs the right number of fixed steps for real elapsed time', () => {
    const gw = createGameWorld(0)
    // 100Hz -> 10ms/tick, so the arithmetic is exact and FP-safe.
    const scheduler = new Scheduler([counterSystem], { tickRate: 100 })
    // 75ms -> 7 full ticks (70ms), 5ms remainder -> alpha 0.5 (under the step cap).
    const alpha = scheduler.advance(gw, 75)
    expect(gw.tick).toBe(7)
    expect(alpha).toBeCloseTo(0.5, 5)
  })

  it('caps steps per frame to avoid the spiral of death', () => {
    const gw = createGameWorld(0)
    const scheduler = new Scheduler([counterSystem], { tickRate: 100, maxStepsPerFrame: 4 })
    // A huge delta would want 100 ticks; the cap clamps it to 4.
    scheduler.advance(gw, 1000)
    expect(gw.tick).toBe(4)
  })
})
