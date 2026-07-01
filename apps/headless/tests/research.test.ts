import { describe, it, expect } from 'vitest'
import { hashState } from '@factory/engine/persistence'
import { bootstrapSim, type Sim } from '../bootstrap.ts'
import {
  MAX_SLOTS,
  RESEARCH_NONE,
  buildingAt,
  createResearchStore,
  registerResearchLab,
  serializeResearch,
  deserializeResearch,
  techTypeOf,
  enqueuePlaceBuilding,
  enqueueSetActiveResearch,
} from '../gameLogic.ts'

/**
 * The research loop: a lab is a store building that stockpiles research packs; while a
 * technology is active the research system drains those packs into it once per cadence until the
 * tech's `cost` is met, then records it complete and goes idle. These tests place a lab, fill its
 * pack buffer directly (isolating the research rule from the belt network, like the village
 * tests), and drive `set_active_research`.
 */

/** item.research_pack colour — the resource a lab stockpiles. */
const PACK = 3062647
/** An opaque tech id (as the host would compute it) to research toward. */
const SMELTING = techTypeOf('tech.basic_smelting')

/** Place a 2x2 lab at (x, y) accepting research packs and let the placement command apply. */
function placeLab(sim: Sim, x: number, y: number): void {
  enqueuePlaceBuilding(sim.world, {
    x,
    y,
    w: 2,
    h: 2,
    color: 0x2b7573,
    accepts: [{ color: PACK, cap: 1000 }],
    researchLab: true,
  })
  sim.scheduler.runTicks(sim.world, 1)
}

/** Set the lab's pack buffer (slot 0) to `n`. */
function setPacks(sim: Sim, x: number, y: number, n: number): void {
  const b = buildingAt(sim.state.buildings, x, y)
  sim.state.buildings.slotCount[b * MAX_SLOTS] = n
}

/** The lab's current pack count (slot 0). */
function packs(sim: Sim, x: number, y: number): number {
  const b = buildingAt(sim.state.buildings, x, y)
  return sim.state.buildings.slotCount[b * MAX_SLOTS]!
}

describe('research loop', () => {
  it('completes the active tech once enough packs are drained, then goes idle', async () => {
    const sim = await bootstrapSim(1)
    placeLab(sim, 20, 20)
    setPacks(sim, 20, 20, 100)
    enqueueSetActiveResearch(sim.world, { tech: SMELTING, cost: 20 })
    sim.scheduler.runTicks(sim.world, 300)
    // The 20-pack cost is met and the tech recorded; research returns to idle (single-active).
    expect(sim.state.research.completed).toContain(SMELTING)
    expect(sim.state.research.activeTech).toBe(RESEARCH_NONE)
    // Only the 20 packs the tech cost were consumed; the surplus stays in the lab.
    expect(packs(sim, 20, 20)).toBe(80)
  })

  it('drains nothing while research is idle (no active tech)', async () => {
    const sim = await bootstrapSim(1)
    placeLab(sim, 20, 20)
    setPacks(sim, 20, 20, 100)
    // No set_active_research: the system is idle and never touches the lab.
    sim.scheduler.runTicks(sim.world, 300)
    expect(sim.state.research.completed).toHaveLength(0)
    expect(packs(sim, 20, 20)).toBe(100)
  })

  it('is deterministic: same seed + feed -> identical research state and hash', async () => {
    const run = async (): Promise<Sim> => {
      const sim = await bootstrapSim(3)
      placeLab(sim, 20, 20)
      setPacks(sim, 20, 20, 15) // below the 20-pack cost — research stays in progress
      enqueueSetActiveResearch(sim.world, { tech: SMELTING, cost: 20 })
      sim.scheduler.runTicks(sim.world, 300)
      return sim
    }
    const a = await run()
    const b = await run()
    // Still researching (15 < 20), and both runs agree exactly on the accumulated progress.
    expect(a.state.research.activeTech).toBe(SMELTING)
    expect(a.state.research.progress).toBe(15)
    expect(a.state.research.progress).toBe(b.state.research.progress)
    expect(a.state.research.completed).toEqual(b.state.research.completed)
    expect(hashState(a.world)).toBe(hashState(b.world))
  })
})

describe('research store serialization', () => {
  it('round-trips every field (labs, active tech, progress, completed, timer)', () => {
    const r = createResearchStore()
    registerResearchLab(r, 3, 4)
    registerResearchLab(r, -2, 7)
    r.activeTech = SMELTING
    r.activeCost = 20
    r.progress = 5
    r.completed = [techTypeOf('tech.mining'), techTypeOf('tech.farming')]
    r.timer = 12

    const snap = serializeResearch(r)
    const restored = deserializeResearch(snap)

    // A second snapshot of the restored store is byte-for-byte the first.
    expect(serializeResearch(restored)).toEqual(snap)
    expect(restored.labCount).toBe(2)
    expect(restored.activeTech).toBe(SMELTING)
    expect(restored.activeCost).toBe(20)
    expect(restored.progress).toBe(5)
    expect(restored.completed).toEqual(r.completed)
    expect(restored.timer).toBe(12)
    expect([restored.lx[0], restored.ly[0]]).toEqual([3, 4])
    expect([restored.lx[1], restored.ly[1]]).toEqual([-2, 7])
  })
})
