import { describe, it, expect } from 'vitest'
import { hashSnapshot } from '@factory/engine/persistence'
import { bootstrapSim, type Sim } from '../bootstrap.ts'
import {
  MAX_SLOTS,
  buildingAt,
  serializeGameState,
  techTypeOf,
  enqueuePlaceBelt,
  enqueuePlaceBuilding,
  enqueuePlaceProducer,
  enqueuePlacePort,
  enqueueSetActiveResearch,
} from '../gameLogic.ts'

/**
 * End-to-end save/load of the WHOLE sim: the engine's entity snapshot PLUS the base mod's
 * out-of-ECS `GameState` (belt grid, building stockpiles, terrain, villages, research), carried
 * in the snapshot's opaque per-mod `modState.base` blob. A save that dropped any of it would
 * silently corrupt the world, so these tests assert a byte-exact round-trip and that a loaded
 * save continues identically to a never-saved run — the M2 reproducibility guarantee.
 */

/** Resource colour the test producer makes and the sink accepts. */
const SRC = 0xf6d600
/** item.research_pack colour — the resource the lab stockpiles (matches research.test.ts). */
const PACK = 3062647
/** An opaque tech id (as the host computes it) to research toward. */
const SMELTING = techTypeOf('tech.basic_smelting')

/** Hash the whole sim: engine entities + the base mod's serialized state. */
function hashSim(sim: Sim): string {
  return hashSnapshot(sim.serialize())
}

/**
 * Place a small but state-rich factory: a producer feeding a belt through an output port into a
 * sink store at the far end, plus a lab stocked with packs and an active technology. After a run,
 * stockpiles, in-flight belt items, craft/port/move timers and research progress have all
 * accumulated — a broad cross-section of the base mod's out-of-ECS state.
 */
function buildFactory(sim: Sim): void {
  enqueuePlaceBelt(sim.world, { ax: 21, ay: 20, bx: 29, by: 20, color: 0x404040, moveEvery: 3 })
  enqueuePlaceProducer(sim.world, {
    x: 20,
    y: 20,
    w: 1,
    h: 1,
    color: 0x223344,
    itemColor: SRC,
    produceEvery: 30,
    storageCap: 100,
  })
  enqueuePlacePort(sim.world, { x: 21, y: 20, port: 'output', color: 0x44dd44, spawnEvery: 5 })
  enqueuePlaceBuilding(sim.world, {
    x: 30,
    y: 20,
    w: 1,
    h: 1,
    color: 0x334455,
    accepts: [{ color: SRC, cap: 1000 }],
  })
  enqueuePlacePort(sim.world, { x: 29, y: 20, port: 'input', color: 0xdd4444 })
  // A 2x2 lab (away from the belt) with packs and an active tech, so research progress accrues.
  enqueuePlaceBuilding(sim.world, {
    x: 40,
    y: 40,
    w: 2,
    h: 2,
    color: 0x2b7573,
    accepts: [{ color: PACK, cap: 1000 }],
    researchLab: true,
  })
  sim.scheduler.runTicks(sim.world, 1) // apply the placements
  const lab = buildingAt(sim.state.buildings, 40, 40)
  sim.state.buildings.slotCount[lab * MAX_SLOTS] = 200
  enqueueSetActiveResearch(sim.world, { tech: SMELTING, cost: [{ color: PACK, amount: 40 }] })
}

describe('full-sim save/load round-trip', () => {
  it('restoring a snapshot reproduces the exact hash and mod-state blob', async () => {
    const src = await bootstrapSim(7)
    buildFactory(src)
    src.scheduler.runTicks(src.world, 500)
    const snap = src.serialize()

    // A save loads into a fresh, scene-less origin (no default scene to collide with).
    const dst = await bootstrapSim(7, { startScene: false })
    dst.restore(snap)

    expect(hashSim(dst)).toBe(hashSim(src))
    expect(serializeGameState(dst.state)).toEqual(serializeGameState(src.state))

    // Sanity: the run actually accumulated state (so the round-trip isn't vacuous).
    const lab = buildingAt(src.state.buildings, 40, 40)
    expect(src.state.research.completed).toContain(SMELTING) // 40 of 200 packs drained
    expect(src.state.buildings.slotCount[lab * MAX_SLOTS]).toBe(160)
    // ...including a mid-accrual village demand accumulator (the fractional-demand state), so the
    // round-trip above genuinely exercises it rather than round-tripping all-zero accumulators.
    expect(src.state.villages.demandAcc.some((x) => x !== 0)).toBe(true)
  })
})

describe('load-continuation determinism', () => {
  it('continuing a loaded save N ticks matches a never-saved run', async () => {
    const A = 300
    const B = 400

    // Never-saved reference: A + B ticks straight through.
    const full = await bootstrapSim(9)
    buildFactory(full)
    full.scheduler.runTicks(full.world, A + B)

    // Save after A ticks, restore into a fresh origin, run the remaining B ticks.
    const src = await bootstrapSim(9)
    buildFactory(src)
    src.scheduler.runTicks(src.world, A)
    const resumed = await bootstrapSim(9, { startScene: false })
    resumed.restore(src.serialize())
    resumed.scheduler.runTicks(resumed.world, B)

    expect(hashSim(resumed)).toBe(hashSim(full))
  })
})

describe('game-state serialization determinism', () => {
  it('two independent runs produce identical mod-state blobs and hashes', async () => {
    const run = async (): Promise<Sim> => {
      const sim = await bootstrapSim(3)
      buildFactory(sim)
      sim.scheduler.runTicks(sim.world, 450)
      return sim
    }
    const a = await run()
    const b = await run()
    expect(serializeGameState(a.state)).toEqual(serializeGameState(b.state))
    expect(hashSim(a)).toBe(hashSim(b))
  })
})
