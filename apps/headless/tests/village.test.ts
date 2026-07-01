import { describe, it, expect } from 'vitest'
import { hashState } from '@factory/engine/persistence'
import { bootstrapSim, type Sim } from '../bootstrap.ts'
import { MAX_SLOTS, buildingAt, villageStageAt } from '../gameLogic.ts'

/**
 * The starting scene registers one village anchored at (-1, -1) with its footprint covering the
 * origin. Its stockpile slots follow the prototype `accepts` order (grain, wood, bread, gear),
 * so slot 0 is grain — the only level-1 demand. These tests drive that buffer directly to
 * isolate the village growth/decline rule from the belt network.
 */
const VILLAGE_ANCHOR = { x: -1, y: -1 }

/** The dense building id of the origin village. */
function villageBuilding(sim: Sim): number {
  return buildingAt(sim.state.buildings, 0, 0)
}

/** Set the village's grain buffer (slot 0) to `n`. */
function setGrain(sim: Sim, n: number): void {
  const b = villageBuilding(sim)
  sim.state.buildings.slotCount[b * MAX_SLOTS] = n
}

/** The village's current stage index (0 = level 1), or -1 if there is no village. */
function stage(sim: Sim): number {
  return villageStageAt(sim.state.villages, VILLAGE_ANCHOR.x, VILLAGE_ANCHOR.y)
}

describe('village growth / decline', () => {
  it('starts at stage 0 (level 1)', async () => {
    const sim = await bootstrapSim(1)
    expect(stage(sim)).toBe(0)
  })

  it('grows a stage when its level-1 demand stays satisfied', async () => {
    const sim = await bootstrapSim(1)
    // Keep grain topped up so level 1 (grain only) is met every cadence.
    setGrain(sim, 100_000)
    sim.scheduler.runTicks(sim.world, 700)
    // ~600 ticks of sustained satisfaction promotes it from stage 0 to stage 1.
    expect(stage(sim)).toBe(1)
  })

  it('declines a stage when a higher tier goes unsupplied, floored at level 1', async () => {
    const sim = await bootstrapSim(1)
    // Grow to stage 1 first.
    setGrain(sim, 100_000)
    sim.scheduler.runTicks(sim.world, 700)
    expect(stage(sim)).toBe(1)
    // Stage 1 also demands wood + bread (never supplied) AND now grain is cut off, so every
    // demand is unmet: after ~600 ticks it drops back to stage 0 and cannot fall below it.
    setGrain(sim, 0)
    sim.scheduler.runTicks(sim.world, 900)
    expect(stage(sim)).toBe(0)
  })

  it('is deterministic: same seed + buffer -> identical stage and timers', async () => {
    const run = async (): Promise<Sim> => {
      const sim = await bootstrapSim(3)
      setGrain(sim, 100_000)
      sim.scheduler.runTicks(sim.world, 1000)
      return sim
    }
    const a = await run()
    const b = await run()
    // The village reached a non-trivial stage (grew), and both runs agree exactly.
    expect(stage(a)).toBe(1)
    expect(stage(a)).toBe(stage(b))
    expect(a.state.villages.growthTimer[0]).toBe(b.state.villages.growthTimer[0])
    expect(a.state.villages.declineTimer[0]).toBe(b.state.villages.declineTimer[0])
    // The ECS-visible state (no moving entities here) is identical too.
    expect(hashState(a.world)).toBe(hashState(b.world))
  })
})
