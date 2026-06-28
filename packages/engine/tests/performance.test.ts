import { describe, it, expect } from 'vitest'
import { createGameWorld, spawnEntity, Scheduler, counterSystem } from '../core/index.ts'

/**
 * Perf REGRESSION GUARD (not a precise benchmark — see performance.bench.ts for
 * that). The budget is deliberately generous: a 60fps frame is ~16.6ms, and this
 * workload (snapshot + trivial system over 10k entities) should sit far below it.
 * The test only trips on an egregious regression — e.g. accidental O(n²) work or
 * per-entity allocation triggering GC churn in the tick loop.
 */
describe('engine performance budget', () => {
  it('ticks 10k entities well under the frame budget', () => {
    const gw = createGameWorld(1)
    const COUNT = 10_000
    for (let i = 0; i < COUNT; i++) {
      spawnEntity(gw, {
        pos: { x: gw.rng.nextInt(-500, 500), y: gw.rng.nextInt(-500, 500) },
        color: 0x4fa8ff,
      })
    }

    const scheduler = new Scheduler([counterSystem])
    const TICKS = 600

    // Warm up so JIT compilation is not counted against the budget.
    scheduler.runTicks(gw, 60)

    const start = performance.now()
    scheduler.runTicks(gw, TICKS)
    const msPerTick = (performance.now() - start) / TICKS

    // ~16.6ms is one frame at 60fps; 4ms leaves generous headroom for real systems.
    expect(msPerTick).toBeLessThan(4)
  })
})
