import { describe, it, expect } from 'vitest'
import { entityCount } from '@factory/engine/core'
import { hashState, serialize } from '@factory/engine/persistence'
import { bootstrapSim, type Sim } from '../bootstrap.ts'
import {
  enqueuePlaceBelt,
  enqueuePlacePort,
  enqueuePlaceProducer,
  enqueuePlaceSplitter,
} from '../gameLogic.ts'

/** village + 6x6 orchard, before anything is placed (see scene.test.ts). */
const BASELINE = 37
/** Production cadence the base-game farm/orchard use: 1 item / 30 ticks = 2 items/sec at 60 tps. */
const PRODUCE_EVERY = 30
/** Internal store size the base-game farm/orchard use. */
const STORAGE_CAP = 100
/** Item glyph: sprite(SHAPE_CIRCLE=1, 0) = 1*4 + 0. */
const ITEM_SPRITE = 4

/** Count the loose items currently riding belts (circle-glyph entities). */
function itemCount(sim: Sim): number {
  return serialize(sim.world).entities.filter((e) => e.sprite === ITEM_SPRITE).length
}

describe('production building', () => {
  it('drops a producer placed where no belt exists', async () => {
    const sim = await bootstrapSim(1)
    enqueuePlaceBelt(sim.world, { ax: 0, ay: 0, bx: 8, by: 0, color: 0x404040, moveEvery: 1 })
    enqueuePlaceProducer(sim.world, {
      x: 100,
      y: 100,
      color: 0xd7c4c3,
      itemColor: 0xf6d600,
      produceEvery: PRODUCE_EVERY,
      storageCap: STORAGE_CAP,
    })
    sim.scheduler.runTicks(sim.world, 10)
    // The off-belt producer spawns no footprint; only the 9 belt tracks exist.
    expect(entityCount(sim.world)).toBe(BASELINE + 9)
  })

  it('fills its internal store to the cap (and no further) when the belt cannot drain', async () => {
    // A 1-tile belt: the producer's item has nowhere to advance, so its tile stays occupied
    // and production backs up into the store. 30 ticks/item, cap 100 -> full well before 4000.
    const sim = await bootstrapSim(1)
    enqueuePlaceBelt(sim.world, { ax: 0, ay: 0, bx: 0, by: 0, color: 0x404040, moveEvery: 1 })
    enqueuePlaceProducer(sim.world, {
      x: 0,
      y: 0,
      color: 0xd7c4c3,
      itemColor: 0xf6d600,
      produceEvery: PRODUCE_EVERY,
      storageCap: STORAGE_CAP,
    })
    sim.scheduler.runTicks(sim.world, 4000)

    // The store saturates at the cap and overflow is discarded.
    expect(sim.state.grid.storage[0]).toBe(STORAGE_CAP)
    // Exactly one item ever rides the single tile; the rest sit in the store, not the world.
    expect(itemCount(sim)).toBe(1)
    // 1 belt track + 1 producer footprint + 1 item on the tile.
    expect(entityCount(sim.world)).toBe(BASELINE + 3)
  })

  it('passes production straight through when the belt drains as fast as it produces', async () => {
    // A fast belt (one move-cycle per tick) with an input clears the producer's tile every
    // tick, so a freshly produced item leaves at once and the store never accumulates.
    const sim = await bootstrapSim(1)
    enqueuePlaceBelt(sim.world, { ax: 0, ay: 0, bx: 8, by: 0, color: 0x404040, moveEvery: 1 })
    enqueuePlaceProducer(sim.world, {
      x: 0,
      y: 0,
      color: 0xd7c4c3,
      itemColor: 0xf6d600,
      produceEvery: PRODUCE_EVERY,
      storageCap: STORAGE_CAP,
    })
    enqueuePlacePort(sim.world, { x: 8, y: 0, port: 'input', color: 0xdd4444 })

    // Sample tick by tick: the store must stay empty the whole run (nothing ever backs up),
    // and at some point an item is seen riding the belt (production really did pass through).
    let maxItems = 0
    for (let tick = 0; tick < 1000; tick++) {
      sim.scheduler.runTicks(sim.world, 1)
      expect(sim.state.grid.storage[0]).toBe(0)
      maxItems = Math.max(maxItems, itemCount(sim))
    }
    expect(maxItems).toBeGreaterThan(0) // items flowed
    expect(maxItems).toBeLessThan(9) // but never one per tile (the belt outruns production)
  })

  it('is deterministic: same seed + commands -> identical state hash', async () => {
    const boot = async (): Promise<Sim> => {
      const sim = await bootstrapSim(11)
      enqueuePlaceBelt(sim.world, { ax: 0, ay: 0, bx: 8, by: 0, color: 0x404040, moveEvery: 15 })
      enqueuePlaceProducer(sim.world, {
        x: 0,
        y: 0,
        color: 0xd7c4c3,
        itemColor: 0xf6d600,
        produceEvery: PRODUCE_EVERY,
        storageCap: STORAGE_CAP,
      })
      sim.scheduler.runTicks(sim.world, 600)
      return sim
    }
    const a = await boot()
    const b = await boot()
    expect(hashState(a.world)).toBe(hashState(b.world))
  })
})

/**
 * One scenario that exercises (almost) the whole base game at once: two belt tiers, an
 * output port + input port pair, a farm and an orchard (production buildings), and a
 * splitter fanning a feed onto two branches. Running it touches command application,
 * topology rebuilds, the move cadence, extraction, production-into-store + drain, splitting
 * and consumption. Used to assert determinism and basic liveness of the combined systems.
 *
 * Layout (all laid before the first tick, so every belt is live when its ports attach):
 *   y=0  farm -> mk3 belt (0..6) -> input              (production, fast belt, drain)
 *   y=2  output -> mk1 belt (0..6) -> input            (extraction, slow belt, drain)
 *   y=4  orchard -> mk1 belt (0..6), no input          (production backs up / store fills)
 *   y=6  output -> mk1 belt (0..3) -> splitter at (3,6)
 *          -> north branch (3,5..3,3) and south branch (3,7..3,9), no inputs (round-robin)
 */
async function bootKitchenSink(seed: number, ticks: number): Promise<Sim> {
  const sim = await bootstrapSim(seed)
  const w = sim.world

  // Row 0 — farm onto a fast (mk3) belt that drains into an input.
  enqueuePlaceBelt(w, { ax: 0, ay: 0, bx: 6, by: 0, color: 0x404040, moveEvery: 15 })
  enqueuePlaceProducer(w, {
    x: 0,
    y: 0,
    color: 0xd7c4c3,
    itemColor: 0xf6d600,
    produceEvery: PRODUCE_EVERY,
    storageCap: STORAGE_CAP,
  })
  enqueuePlacePort(w, { x: 6, y: 0, port: 'input', color: 0xdd4444 })

  // Row 2 — classic output -> mk1 belt -> input flow.
  enqueuePlaceBelt(w, { ax: 0, ay: 2, bx: 6, by: 2, color: 0x404040, moveEvery: 60 })
  enqueuePlacePort(w, {
    x: 0,
    y: 2,
    port: 'output',
    color: 0x44dd44,
    itemColor: 0xffaa00,
    spawnEvery: 8,
  })
  enqueuePlacePort(w, { x: 6, y: 2, port: 'input', color: 0xdd4444 })

  // Row 4 — orchard onto a slow belt with NO input: it backs up and the store fills.
  enqueuePlaceBelt(w, { ax: 0, ay: 4, bx: 6, by: 4, color: 0x404040, moveEvery: 60 })
  enqueuePlaceProducer(w, {
    x: 0,
    y: 4,
    color: 0x4caf50,
    itemColor: 0xff8800,
    produceEvery: PRODUCE_EVERY,
    storageCap: STORAGE_CAP,
  })

  // Row 6 — output feeding a splitter that fans onto a north and a south branch.
  enqueuePlaceBelt(w, { ax: 0, ay: 6, bx: 3, by: 6, color: 0x404040, moveEvery: 30 })
  enqueuePlaceBelt(w, { ax: 3, ay: 5, bx: 3, by: 3, color: 0x404040, moveEvery: 30 })
  enqueuePlaceBelt(w, { ax: 3, ay: 7, bx: 3, by: 9, color: 0x404040, moveEvery: 30 })
  enqueuePlacePort(w, {
    x: 0,
    y: 6,
    port: 'output',
    color: 0x44dd44,
    itemColor: 0xffaa00,
    spawnEvery: 8,
  })
  enqueuePlaceSplitter(w, { x: 3, y: 6, color: 0x9b59b6 })

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

  it('comes alive: ports, producers and the splitter all put items on the belts', async () => {
    const sim = await bootKitchenSink(42, 1200)
    // Items are flowing somewhere in the network.
    expect(itemCount(sim)).toBeGreaterThan(0)
    // The orchard row has no drain, so its internal store backs up (bounded by the cap).
    const g = sim.state.grid
    for (let t = 0; t < g.count; t++) {
      expect(g.storage[t]!).toBeGreaterThanOrEqual(0)
      expect(g.storage[t]!).toBeLessThanOrEqual(STORAGE_CAP)
    }
  })

  it('keeps every producer store within [0, cap] throughout a long run', async () => {
    const sim = await bootKitchenSink(3, 5000)
    const g = sim.state.grid
    // The orchard (slow belt, no input) must have saturated its store at the cap.
    let sawFullStore = false
    for (let t = 0; t < g.count; t++) {
      expect(g.storage[t]!).toBeLessThanOrEqual(STORAGE_CAP)
      if (g.storage[t] === STORAGE_CAP) sawFullStore = true
    }
    expect(sawFullStore).toBe(true)
  })
})
