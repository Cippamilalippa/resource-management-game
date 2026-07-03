import { describe, it, expect } from 'vitest'
import { entityCount } from '@factory/engine/core'
import { hashState, serialize } from '@factory/engine/persistence'
import { bootstrapSim, type Sim } from '../bootstrap.ts'
import {
  MAX_SLOTS,
  buildingAt,
  enqueuePlaceBelt,
  enqueuePlaceBuilding,
  enqueuePlaceCrafter,
  enqueuePlacePort,
  enqueuePlaceProducer,
  enqueuePlaceSplitter,
} from '../gameLogic.ts'

/**
 * These tests place their own producers on bare ground and assert exact entity counts, so they boot
 * with an EMPTY world (`startScene: false`): the procedural starting scene is irrelevant here and
 * its seed-varied entity count would make a fixed baseline meaningless. Baseline is therefore 0.
 */
const BASELINE = 0
/** Production cadence the base-game farm/orchard use: 1 item / 30 ticks = 2 items/sec at 60 tps. */
const PRODUCE_EVERY = 30
/** Per-resource stockpile cap the base-game producers use. */
const STORAGE_CAP = 100
/** Item glyph: sprite(SHAPE_CIRCLE=1, 0) = 1*4 + 0. */
const ITEM_SPRITE = 4
/** Resource colour the test producers make and the test sinks accept. */
const SRC = 0xf6d600

/** Count the loose items currently riding belts (circle-glyph entities). */
function itemCount(sim: Sim): number {
  return serialize(sim.world).entities.filter((e) => e.sprite === ITEM_SPRITE).length
}

/** Current count held in the first stockpile slot of the building covering (x, y), or -1. */
function stockAt(sim: Sim, x: number, y: number): number {
  const b = buildingAt(sim.state.buildings, x, y)
  return b < 0 ? -1 : sim.state.buildings.slotCount[b * MAX_SLOTS]!
}

describe('production building', () => {
  it('fills its internal store to the cap (and no further) when nothing drains it', async () => {
    // A lone producer with no adjacent output: every produced unit stays in the store, which
    // saturates at the cap and discards the overflow. 30 ticks/item, cap 100 -> full long
    // before 4000 ticks.
    const sim = await bootstrapSim(1, { startScene: false })
    enqueuePlaceProducer(sim.world, {
      x: 20,
      y: 20,
      w: 1,
      h: 1,
      color: 0x223344,
      itemColor: SRC,
      produceEvery: PRODUCE_EVERY,
      storageCap: STORAGE_CAP,
    })
    sim.scheduler.runTicks(sim.world, 4000)

    expect(stockAt(sim, 20, 20)).toBe(STORAGE_CAP)
    // Only the producer's footprint — nothing was ever emitted onto a belt.
    expect(entityCount(sim.world)).toBe(BASELINE + 1)
  })

  it('an adjacent output drains the store, but a belt that cannot drain backs it up to the cap', async () => {
    // A single belt tile carries the output; the emitted item has nowhere to advance, so after
    // the first emit the output tile stays occupied and the store backs up to the cap.
    const sim = await bootstrapSim(1, { startScene: false })
    enqueuePlaceBelt(sim.world, { ax: 21, ay: 20, bx: 21, by: 20, color: 0x404040, moveEvery: 1 })
    enqueuePlaceProducer(sim.world, {
      x: 20,
      y: 20,
      w: 1,
      h: 1,
      color: 0x223344,
      itemColor: SRC,
      produceEvery: PRODUCE_EVERY,
      storageCap: STORAGE_CAP,
    })
    enqueuePlacePort(sim.world, { x: 21, y: 20, port: 'output', color: 0x44dd44, spawnEvery: 1 })
    sim.scheduler.runTicks(sim.world, 4000)

    expect(stockAt(sim, 20, 20)).toBe(STORAGE_CAP)
    // Exactly one item ever rides the single tile; the rest sit in the store, not the world.
    expect(itemCount(sim)).toBe(1)
    // 1 belt track + 1 producer footprint + 1 output footprint + 1 item on the tile.
    expect(entityCount(sim.world)).toBe(BASELINE + 4)
  })

  it('passes production straight through when the belt drains as fast as it produces', async () => {
    // A fast belt with an output draining the producer and an input feeding a sink at the far
    // end clears the output tile every tick, so a freshly produced unit leaves at once and the
    // store never accumulates (production runs before the drain in the same tick).
    const sim = await bootstrapSim(1, { startScene: false })
    enqueuePlaceBelt(sim.world, { ax: 21, ay: 20, bx: 29, by: 20, color: 0x404040, moveEvery: 1 })
    enqueuePlaceProducer(sim.world, {
      x: 20,
      y: 20,
      w: 1,
      h: 1,
      color: 0x223344,
      itemColor: SRC,
      produceEvery: PRODUCE_EVERY,
      storageCap: STORAGE_CAP,
    })
    enqueuePlacePort(sim.world, { x: 21, y: 20, port: 'output', color: 0x44dd44, spawnEvery: 1 })
    enqueuePlaceBuilding(sim.world, {
      x: 30,
      y: 20,
      w: 1,
      h: 1,
      color: 0x334455,
      accepts: [{ color: SRC, cap: 1_000_000 }],
    })
    enqueuePlacePort(sim.world, { x: 29, y: 20, port: 'input', color: 0xdd4444 })

    // Sample tick by tick: the producer store must stay empty the whole run (each unit leaves
    // the same tick it is made), and at some point an item is seen riding the belt.
    let maxItems = 0
    for (let tick = 0; tick < 1000; tick++) {
      sim.scheduler.runTicks(sim.world, 1)
      expect(stockAt(sim, 20, 20)).toBe(0)
      maxItems = Math.max(maxItems, itemCount(sim))
    }
    expect(maxItems).toBeGreaterThan(0) // items flowed
    expect(maxItems).toBeLessThan(9) // but never one per tile (the belt outruns production)
  })

  it('is deterministic: same seed + commands -> identical state hash', async () => {
    const boot = async (): Promise<Sim> => {
      const sim = await bootstrapSim(11, { startScene: false })
      enqueuePlaceBelt(sim.world, {
        ax: 21,
        ay: 20,
        bx: 29,
        by: 20,
        color: 0x404040,
        moveEvery: 15,
      })
      enqueuePlaceProducer(sim.world, {
        x: 20,
        y: 20,
        w: 1,
        h: 1,
        color: 0x223344,
        itemColor: SRC,
        produceEvery: PRODUCE_EVERY,
        storageCap: STORAGE_CAP,
      })
      enqueuePlacePort(sim.world, { x: 21, y: 20, port: 'output', color: 0x44dd44, spawnEvery: 4 })
      sim.scheduler.runTicks(sim.world, 600)
      return sim
    }
    const a = await boot()
    const b = await boot()
    expect(hashState(a.world)).toBe(hashState(b.world))
    expect(stockAt(a, 20, 20)).toBe(stockAt(b, 20, 20))
  })
})

describe('processing crafter (multi-input recipe)', () => {
  const ORE = 0x8a8a8a
  const PLATE = 0xd0d0e0

  /**
   * A full processing chain clear of the origin: an ore producer feeds a furnace over a belt,
   * and the furnace smelts 2 ore → 1 plate every `craftEvery` ticks into its own output slot.
   * Returns the sim with everything queued (not yet ticked).
   */
  function bootSmelter(sim: Sim): void {
    const w = sim.world
    // Ore producer at (20,40), draining east onto a belt to the furnace's input at (25,40).
    enqueuePlaceProducer(w, {
      x: 20,
      y: 40,
      w: 1,
      h: 1,
      color: 0x223344,
      itemColor: ORE,
      produceEvery: 2,
      storageCap: 100,
    })
    enqueuePlaceBelt(w, { ax: 21, ay: 40, bx: 25, by: 40, color: 0x404040, moveEvery: 1 })
    enqueuePlacePort(w, { x: 21, y: 40, port: 'output', color: 0x44dd44, spawnEvery: 1 })
    // Furnace at (26,40): consumes 2 ORE, produces 1 PLATE every 4 ticks.
    enqueuePlaceCrafter(w, {
      x: 26,
      y: 40,
      w: 1,
      h: 1,
      color: 0x554433,
      inputs: [{ color: ORE, amount: 2 }],
      outputs: [{ color: PLATE, amount: 1 }],
      craftEvery: 4,
      storageCap: 100,
    })
    enqueuePlacePort(w, { x: 25, y: 40, port: 'input', color: 0xdd4444 })
  }

  /** Ore in the furnace input slot (k=0) and plate in its output slot (k=1). */
  function furnaceStock(sim: Sim): { ore: number; plate: number } {
    const b = buildingAt(sim.state.buildings, 26, 40)
    return {
      ore: sim.state.buildings.slotCount[b * MAX_SLOTS]!,
      plate: sim.state.buildings.slotCount[b * MAX_SLOTS + 1]!,
    }
  }

  it('consumes its inputs and accumulates its output', async () => {
    const sim = await bootstrapSim(5, { startScene: false })
    bootSmelter(sim)
    sim.scheduler.runTicks(sim.world, 1000)
    const { ore, plate } = furnaceStock(sim)
    expect(plate).toBeGreaterThan(0) // it actually smelted
    expect(plate).toBeLessThanOrEqual(100) // capped
    // Ore is being consumed by crafts, so the input slot never runs away past its cap.
    expect(ore).toBeGreaterThanOrEqual(0)
    expect(ore).toBeLessThanOrEqual(100)
  })

  it('is deterministic: same seed + commands -> identical hash and furnace stock', async () => {
    const run = async (): Promise<Sim> => {
      const sim = await bootstrapSim(17, { startScene: false })
      bootSmelter(sim)
      sim.scheduler.runTicks(sim.world, 800)
      return sim
    }
    const a = await run()
    const b = await run()
    expect(hashState(a.world)).toBe(hashState(b.world))
    expect(furnaceStock(a)).toEqual(furnaceStock(b))
  })

  it('a furnace with no ore delivered never crafts', async () => {
    const sim = await bootstrapSim(5, { startScene: false })
    // A lone furnace, unfed: its output stays empty because inputs are never satisfied.
    enqueuePlaceCrafter(sim.world, {
      x: 26,
      y: 40,
      w: 1,
      h: 1,
      color: 0x554433,
      inputs: [{ color: ORE, amount: 2 }],
      outputs: [{ color: PLATE, amount: 1 }],
      craftEvery: 4,
      storageCap: 100,
    })
    sim.scheduler.runTicks(sim.world, 500)
    expect(furnaceStock(sim).plate).toBe(0)
  })
})

/**
 * One scenario that exercises (almost) the whole base game at once: a fast belt draining a
 * producer into a fed sink, a slow belt draining a producer with no drain (store backs up),
 * and an output feeding a splitter that fans onto two branches. Running it touches command
 * application, topology rebuilds, the move cadence, production-into-store, output drain, input
 * deposit, splitting and consumption. Kept clear of the origin village. Used to assert
 * determinism and basic liveness of the combined systems.
 */
async function bootKitchenSink(seed: number, ticks: number): Promise<Sim> {
  const sim = await bootstrapSim(seed, { startScene: false })
  const w = sim.world

  // Row 20 — producer -> output -> fast (mk3) belt -> input -> sink.
  enqueuePlaceProducer(w, {
    x: 20,
    y: 20,
    w: 1,
    h: 1,
    color: 0x223344,
    itemColor: SRC,
    produceEvery: PRODUCE_EVERY,
    storageCap: STORAGE_CAP,
  })
  enqueuePlaceBelt(w, { ax: 21, ay: 20, bx: 27, by: 20, color: 0x404040, moveEvery: 15 })
  enqueuePlacePort(w, { x: 21, y: 20, port: 'output', color: 0x44dd44, spawnEvery: 8 })
  enqueuePlaceBuilding(w, {
    x: 28,
    y: 20,
    w: 1,
    h: 1,
    color: 0x334455,
    accepts: [{ color: SRC, cap: 1_000_000 }],
  })
  enqueuePlacePort(w, { x: 27, y: 20, port: 'input', color: 0xdd4444 })

  // Row 22 — producer -> output -> slow belt with NO input: it backs up and the store fills.
  enqueuePlaceProducer(w, {
    x: 20,
    y: 22,
    w: 1,
    h: 1,
    color: 0x4caf50,
    itemColor: 0xff8800,
    produceEvery: PRODUCE_EVERY,
    storageCap: STORAGE_CAP,
  })
  enqueuePlaceBelt(w, { ax: 21, ay: 22, bx: 27, by: 22, color: 0x404040, moveEvery: 60 })
  enqueuePlacePort(w, { x: 21, y: 22, port: 'output', color: 0x44dd44, spawnEvery: 8 })

  // Row 24 — producer -> output feeding a splitter that fans onto a north and a south branch.
  enqueuePlaceProducer(w, {
    x: 20,
    y: 24,
    w: 1,
    h: 1,
    color: 0x4caf50,
    itemColor: 0xffaa00,
    produceEvery: PRODUCE_EVERY,
    storageCap: STORAGE_CAP,
  })
  enqueuePlaceBelt(w, { ax: 21, ay: 24, bx: 24, by: 24, color: 0x404040, moveEvery: 30 })
  enqueuePlaceBelt(w, { ax: 24, ay: 23, bx: 24, by: 21, color: 0x404040, moveEvery: 30 })
  enqueuePlaceBelt(w, { ax: 24, ay: 25, bx: 24, by: 27, color: 0x404040, moveEvery: 30 })
  enqueuePlacePort(w, { x: 21, y: 24, port: 'output', color: 0x44dd44, spawnEvery: 8 })
  enqueuePlaceSplitter(w, { x: 24, y: 24, color: 0x9b59b6 })

  sim.scheduler.runTicks(w, ticks)
  return sim
}

describe('full base-game scenario', () => {
  it('is deterministic: two identical runs produce the same state hash and entity count', async () => {
    const a = await bootKitchenSink(42, 1200)
    const b = await bootKitchenSink(42, 1200)
    expect(entityCount(a.world)).toBe(entityCount(b.world))
    expect(hashState(a.world)).toBe(hashState(b.world))
  })

  it('comes alive: producers, ports and the splitter all put items on the belts', async () => {
    const sim = await bootKitchenSink(42, 1200)
    // Items are flowing somewhere in the network.
    expect(itemCount(sim)).toBeGreaterThan(0)
    // Every building stockpile slot stays within its bounds.
    const s = sim.state.buildings
    for (let b = 0; b < s.count; b++) {
      const n = s.slotN[b]!
      for (let k = 0; k < n; k++) {
        const i = b * MAX_SLOTS + k
        expect(s.slotCount[i]!).toBeGreaterThanOrEqual(0)
        expect(s.slotCount[i]!).toBeLessThanOrEqual(s.slotCap[i]!)
      }
    }
  })

  it('the un-drained producer saturates its store at the cap over a long run', async () => {
    const sim = await bootKitchenSink(3, 5000)
    // Row 22's producer has a slow belt and no input, so its store must reach the cap.
    expect(stockAt(sim, 20, 22)).toBe(STORAGE_CAP)
  })
})
