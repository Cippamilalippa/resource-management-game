import { bench, describe } from 'vitest'
import { createGameWorld, spawnEntity, Scheduler, counterSystem } from '../core/index.ts'

/**
 * Informational micro-benchmarks. Run with `pnpm bench`. These are NOT part of the
 * normal test run (vitest only executes *.test.ts); use them to measure the cost of
 * the hot path when changing it.
 */
function worldWith(count: number) {
  const gw = createGameWorld(1)
  for (let i = 0; i < count; i++) {
    spawnEntity(gw, {
      pos: { x: gw.rng.nextInt(-500, 500), y: gw.rng.nextInt(-500, 500) },
      color: 0x4fa8ff,
    })
  }
  return gw
}

describe('scheduler tick', () => {
  for (const count of [1_000, 10_000, 50_000]) {
    const gw = worldWith(count)
    const scheduler = new Scheduler([counterSystem])
    bench(`tick ${count.toLocaleString()} entities`, () => {
      scheduler.tick(gw)
    })
  }
})
