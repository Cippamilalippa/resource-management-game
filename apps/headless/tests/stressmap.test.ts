import { describe, it, expect } from 'vitest'
import { entityCount } from '@factory/engine/core'
import { hashState, hashSnapshot } from '@factory/engine/persistence'
import { bootstrapSim, type Sim } from '../bootstrap.ts'
import { buildStressMap } from '../stressmap.ts'
import { serializeGameState } from '../gameLogic.ts'

/**
 * The stress map ({@link ../stressmap.ts}) tiles many full production chains so the sim runs at
 * scale. These tests pin the two properties that make it a useful test artifact: it is fully
 * deterministic (same seed + cell count → identical hash, the harness's non-negotiable guarantee)
 * and it is actually *live* — the chains flow end to end (the terminal depots bank output). Kept to
 * a modest cell count so it stays fast in CI.
 */
async function buildAndRun(cells: number, ticks: number): Promise<Sim> {
  const sim = await bootstrapSim(1, { startScene: false })
  buildStressMap(sim, cells)
  sim.scheduler.runTicks(sim.world, ticks)
  return sim
}

describe('stress map', () => {
  it('tiles the requested cells into a populous world', async () => {
    const sim = await bootstrapSim(1, { startScene: false })
    const built = buildStressMap(sim, 40)
    expect(built.cells).toBe(40)
    // Each cell is a producer + 5 crafters + a depot + a dozen belt/port tiles — hundreds of
    // entities for 40 cells, thousands at the runner's default. Proves the map is densely populated.
    expect(entityCount(sim.world)).toBeGreaterThan(40 * 20)
  })

  it('runs a live chain: the terminal depots bank output', async () => {
    const sim = await buildAndRun(20, 1200)
    // A depot sells belted-in goods for credits, so a non-zero balance means raw flowed all the
    // way down the chain (produce → 5 crafts → belt → depot) — the map is genuinely simulating.
    expect(sim.state.treasury.credits).toBeGreaterThan(0)
  })

  it('is deterministic: same cells + ticks → identical hash', async () => {
    const a = await buildAndRun(24, 800)
    const b = await buildAndRun(24, 800)
    expect(hashState(a.world, { base: serializeGameState(a.state) })).toBe(
      hashState(b.world, { base: serializeGameState(b.state) }),
    )
    expect(hashSnapshot(a.serialize())).toBe(hashSnapshot(b.serialize()))
  })
})
