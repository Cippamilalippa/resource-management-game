import { describe, it, expect } from 'vitest'
import { serialize, hashState } from '@factory/engine/persistence'
import { bootstrapSim, type Sim } from '../bootstrap.ts'
import {
  MAX_SLOTS,
  buildingAt,
  enqueuePlaceBelt,
  enqueuePlaceBuilding,
  enqueuePlacePort,
  enqueuePlaceProducer,
} from '../gameLogic.ts'

/** Resource colour the test producer makes. */
const SRC = 0xf6d600
/** A different resource the producer never makes (for the rejection test). */
const OTHER = 0x123456
/** Item glyph: sprite(SHAPE_CIRCLE=1, 0). */
const ITEM_SPRITE = 4

/** Count the loose items currently riding belts (circle-glyph entities). */
function itemCount(sim: Sim): number {
  return serialize(sim.world).entities.filter((e) => e.sprite === ITEM_SPRITE).length
}

/** Count held in stockpile slot `k` of the building covering (x, y), or -1 if none there. */
function stockAt(sim: Sim, x: number, y: number, k = 0): number {
  const b = buildingAt(sim.state.buildings, x, y)
  return b < 0 ? -1 : sim.state.buildings.slotCount[b * MAX_SLOTS + k]!
}

/**
 * Lay the full chain at y=20 (clear of the origin village): a producer making SRC, an output
 * draining it onto an 8-tile belt, and an input at the far end feeding a sink building whose
 * accept list / cap the caller chooses. Returns the sim with all of it queued (not yet ticked).
 */
function bootChain(sim: Sim, sinkAccepts: number, sinkCap: number, produceEvery = 5): void {
  const w = sim.world
  enqueuePlaceProducer(w, {
    x: 20,
    y: 20,
    w: 1,
    h: 1,
    color: 0x223344,
    itemColor: SRC,
    produceEvery,
    storageCap: 100,
  })
  enqueuePlaceBelt(w, { ax: 21, ay: 20, bx: 28, by: 20, color: 0x404040, moveEvery: 1 })
  enqueuePlacePort(w, { x: 21, y: 20, port: 'output', color: 0x44dd44, spawnEvery: 1 })
  enqueuePlaceBuilding(w, {
    x: 29,
    y: 20,
    w: 1,
    h: 1,
    color: 0x334455,
    accepts: [{ color: sinkAccepts, cap: sinkCap }],
  })
  enqueuePlacePort(w, { x: 28, y: 20, port: 'input', color: 0xdd4444 })
}

describe('building stockpiles', () => {
  it('an input deposits an accepted resource into its building, clearing it off the belt', async () => {
    const sim = await bootstrapSim(1)
    bootChain(sim, SRC, 1_000_000)
    sim.scheduler.runTicks(sim.world, 1000)
    // The sink accumulated the resource the producer made.
    expect(stockAt(sim, 29, 20)).toBeGreaterThan(0)
    // Items are consumed at the input, so the belt never fully backs up.
    expect(itemCount(sim)).toBeLessThan(8)
  })

  it('an input rejects a resource its building does not accept — items back up instead', async () => {
    const sim = await bootstrapSim(1)
    // The sink accepts OTHER, but the belt carries SRC: nothing is deposited and the belt fills.
    bootChain(sim, OTHER, 1_000_000)
    sim.scheduler.runTicks(sim.world, 1000)
    expect(stockAt(sim, 29, 20)).toBe(0)
    // The belt backs up: an item sits on (nearly) every belt tile.
    expect(itemCount(sim)).toBeGreaterThanOrEqual(8)
  })

  it('an input stops depositing at the cap, then backs the belt up', async () => {
    const sim = await bootstrapSim(1)
    bootChain(sim, SRC, 5)
    sim.scheduler.runTicks(sim.world, 1000)
    // The sink fills to exactly its cap and accepts no more.
    expect(stockAt(sim, 29, 20)).toBe(5)
    // With the sink full, the belt backs up behind the input.
    expect(itemCount(sim)).toBeGreaterThanOrEqual(8)
  })

  it('an output linked to no building emits nothing', async () => {
    const sim = await bootstrapSim(1)
    // A belt with an output but no adjacent building: there is nothing to drain.
    enqueuePlaceBelt(sim.world, { ax: 20, ay: 30, bx: 28, by: 30, color: 0x404040, moveEvery: 1 })
    enqueuePlacePort(sim.world, { x: 20, y: 30, port: 'output', color: 0x44dd44, spawnEvery: 1 })
    sim.scheduler.runTicks(sim.world, 500)
    expect(itemCount(sim)).toBe(0)
  })

  it('links a port to a building placed *after* it (relink on building placement)', async () => {
    const sim = await bootstrapSim(1)
    const w = sim.world
    // Output is queued before its producer: it must still link once the producer is placed.
    enqueuePlaceBelt(w, { ax: 21, ay: 30, bx: 28, by: 30, color: 0x404040, moveEvery: 1 })
    enqueuePlacePort(w, { x: 21, y: 30, port: 'output', color: 0x44dd44, spawnEvery: 1 })
    enqueuePlaceProducer(w, {
      x: 20,
      y: 30,
      w: 1,
      h: 1,
      color: 0x223344,
      itemColor: SRC,
      produceEvery: 1,
      storageCap: 100,
    })
    sim.scheduler.runTicks(w, 200)
    // The relink let the output drain the producer, so items reached the belt.
    expect(itemCount(sim)).toBeGreaterThan(0)
  })

  it('is deterministic: the full produce -> output -> belt -> input -> store loop', async () => {
    const run = async (): Promise<Sim> => {
      const sim = await bootstrapSim(9)
      bootChain(sim, SRC, 50, 5)
      sim.scheduler.runTicks(sim.world, 1500)
      return sim
    }
    const a = await run()
    const b = await run()
    expect(hashState(a.world)).toBe(hashState(b.world))
    expect(stockAt(a, 29, 20)).toBe(stockAt(b, 29, 20))
  })
})
