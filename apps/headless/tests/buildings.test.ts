import { describe, it, expect } from 'vitest'
import { serialize, hashState } from '@factory/engine/persistence'
import { bootstrapSim, type Sim } from '../bootstrap.ts'
import {
  MAX_SLOTS,
  buildingAt,
  terrainTypeAt,
  enqueuePlaceBelt,
  enqueuePlaceBuilding,
  enqueuePlacePort,
  enqueuePlaceProducer,
  enqueuePlaceSplitter,
  enqueueRemove,
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

/** The belt-grid tile id at (x, y), or -1 if none. */
function tileIdAt(sim: Sim, x: number, y: number): number {
  const g = sim.state.grid
  for (let t = 0; t < g.count; t++) if (g.tx[t]! === x && g.ty[t]! === y) return t
  return -1
}

describe('directional ports (arrow picks the building)', () => {
  /**
   * An output tile flanked by two producers — one WEST making SRC, one NORTH making OTHER —
   * with its arrow facing East. The arrow points *away* from the building it drains, so it must
   * bind to the WEST producer (opposite the facing) and ignore the one to the North.
   */
  async function bootTwoNeighbours(seed: number, dir: number): Promise<Sim> {
    const sim = await bootstrapSim(seed)
    const w = sim.world
    enqueuePlaceBelt(w, { ax: 5, ay: 5, bx: 9, by: 5, color: 0x404040, moveEvery: 1 })
    enqueuePlaceProducer(w, {
      x: 4,
      y: 5,
      w: 1,
      h: 1,
      color: 0x223344,
      itemColor: SRC,
      produceEvery: 1,
      storageCap: 100,
    }) // WEST
    enqueuePlaceProducer(w, {
      x: 5,
      y: 4,
      w: 1,
      h: 1,
      color: 0x224433,
      itemColor: OTHER,
      produceEvery: 1,
      storageCap: 100,
    }) // NORTH
    enqueuePlacePort(w, { x: 5, y: 5, port: 'output', color: 0x44dd44, spawnEvery: 1, dir })
    return sim
  }

  it('drains only the building behind the arrow, even with two bordering buildings', async () => {
    const sim = await bootTwoNeighbours(1, 1) // arrow East → drain the WEST building
    sim.scheduler.runTicks(sim.world, 200)
    // The output is linked to the WEST producer, not the NORTH one.
    expect(sim.state.grid.portBuilding[tileIdAt(sim, 5, 5)]!).toBe(
      buildingAt(sim.state.buildings, 4, 5),
    )
    // Every item riding the belt is SRC (the west producer's), never OTHER (the north one's).
    const colors = serialize(sim.world)
      .entities.filter((e) => e.sprite === ITEM_SPRITE)
      .map((e) => e.color)
    expect(colors.length).toBeGreaterThan(0)
    expect(colors.every((c) => c === SRC)).toBe(true)
    // The north producer is never drained, so it fills to its cap and stays there.
    expect(stockAt(sim, 5, 4)).toBe(100)
  })

  it('binds to the other building when the arrow is rotated to face it', async () => {
    const sim = await bootTwoNeighbours(1, 2) // arrow South → drain the NORTH building
    sim.scheduler.runTicks(sim.world, 200)
    expect(sim.state.grid.portBuilding[tileIdAt(sim, 5, 5)]!).toBe(
      buildingAt(sim.state.buildings, 5, 4),
    )
    const colors = serialize(sim.world)
      .entities.filter((e) => e.sprite === ITEM_SPRITE)
      .map((e) => e.color)
    expect(colors.length).toBeGreaterThan(0)
    expect(colors.every((c) => c === OTHER)).toBe(true)
  })

  it('an input feeds only the building its arrow points at', async () => {
    const sim = await bootstrapSim(1)
    const w = sim.world
    enqueuePlaceBelt(w, { ax: 5, ay: 5, bx: 9, by: 5, color: 0x404040, moveEvery: 1 })
    enqueuePlaceProducer(w, {
      x: 4,
      y: 5,
      w: 1,
      h: 1,
      color: 0x223344,
      itemColor: SRC,
      produceEvery: 1,
      storageCap: 1_000_000,
    })
    enqueuePlacePort(w, { x: 5, y: 5, port: 'output', color: 0x44dd44, spawnEvery: 1, dir: 1 })
    // A sink to the NORTH of the input tile and another to the SOUTH; the arrow points North.
    enqueuePlaceBuilding(w, {
      x: 9,
      y: 4,
      w: 1,
      h: 1,
      color: 0x334455,
      accepts: [{ color: SRC, cap: 1_000_000 }],
    }) // NORTH
    enqueuePlaceBuilding(w, {
      x: 9,
      y: 6,
      w: 1,
      h: 1,
      color: 0x445566,
      accepts: [{ color: SRC, cap: 1_000_000 }],
    }) // SOUTH
    enqueuePlacePort(w, { x: 9, y: 5, port: 'input', color: 0xdd4444, dir: 0 }) // arrow North
    sim.scheduler.runTicks(w, 600)
    // Only the building the arrow points at (North) accumulates; the South sink stays empty.
    expect(stockAt(sim, 9, 4)).toBeGreaterThan(0)
    expect(stockAt(sim, 9, 6)).toBe(0)
  })

  it('is deterministic with explicitly-rotated ports', async () => {
    const a = await bootTwoNeighbours(9, 2)
    const b = await bootTwoNeighbours(9, 2)
    a.scheduler.runTicks(a.world, 400)
    b.scheduler.runTicks(b.world, 400)
    expect(hashState(a.world)).toBe(hashState(b.world))
  })
})

describe('removing objects', () => {
  it('removes a belt tile, dropping it from the grid', async () => {
    const sim = await bootstrapSim(1)
    enqueuePlaceBelt(sim.world, { ax: 20, ay: 20, bx: 24, by: 20, color: 0x404040, moveEvery: 1 })
    sim.scheduler.runTicks(sim.world, 1)
    expect(sim.state.grid.count).toBe(5)
    // Delete the middle tile; the grid compacts and the tile is gone from the index.
    enqueueRemove(sim.world, { x: 22, y: 20 })
    sim.scheduler.runTicks(sim.world, 1)
    expect(sim.state.grid.count).toBe(4)
    expect(tileIdAt(sim, 22, 20)).toBe(-1)
    // The surviving tiles are still addressable (the swap-removed tile re-indexed correctly).
    expect(tileIdAt(sim, 20, 20)).toBeGreaterThanOrEqual(0)
    expect(tileIdAt(sim, 24, 20)).toBeGreaterThanOrEqual(0)
  })

  it('removing a building unlinks the output port that drained it and halts the chain', async () => {
    const sim = await bootstrapSim(1)
    bootChain(sim, SRC, 1_000_000)
    sim.scheduler.runTicks(sim.world, 200)
    expect(stockAt(sim, 29, 20)).toBeGreaterThan(0)
    const stocked = stockAt(sim, 29, 20)
    // Remove the producer feeding the line; its output port must unlink (no dangling building id).
    enqueueRemove(sim.world, { x: 20, y: 20 })
    sim.scheduler.runTicks(sim.world, 1)
    expect(buildingAt(sim.state.buildings, 20, 20)).toBe(-1)
    expect(sim.state.grid.portBuilding[tileIdAt(sim, 21, 20)]!).toBe(-1)
    // With nothing to drain, the belt drains out and the sink stops growing past the in-flight items.
    sim.scheduler.runTicks(sim.world, 400)
    expect(stockAt(sim, 29, 20)).toBeLessThan(stocked + 8)
  })

  it('leaves passive terrain untouched (a deposit cannot be deleted)', async () => {
    const sim = await bootstrapSim(1)
    // Find any deposit tile the (procedural) scene painted — its position varies with the seed, so
    // scan for the first non-empty terrain tile rather than assuming a fixed patch corner.
    let dx = 0
    let dy = 0
    let before = 0
    outer: for (let y = -40; y <= 40; y++) {
      for (let x = -40; x <= 40; x++) {
        const t = terrainTypeAt(sim.state.terrain, x, y)
        if (t !== 0) {
          dx = x
          dy = y
          before = t
          break outer
        }
      }
    }
    expect(before).not.toBe(0)
    enqueueRemove(sim.world, { x: dx, y: dy })
    sim.scheduler.runTicks(sim.world, 1)
    // Terrain is in neither store, so the remove is a no-op: the soil is still there.
    expect(terrainTypeAt(sim.state.terrain, dx, dy)).toBe(before)
    expect(buildingAt(sim.state.buildings, dx, dy)).toBe(-1)
  })

  it('is deterministic across a build-then-remove sequence', async () => {
    const run = async (): Promise<Sim> => {
      const sim = await bootstrapSim(7)
      bootChain(sim, SRC, 50, 5)
      enqueuePlaceSplitter(sim.world, { x: 24, y: 20, color: 0x888888 })
      sim.scheduler.runTicks(sim.world, 120)
      enqueueRemove(sim.world, { x: 22, y: 20 }) // a belt tile mid-run
      enqueueRemove(sim.world, { x: 20, y: 20 }) // the producer building
      sim.scheduler.runTicks(sim.world, 200)
      return sim
    }
    const a = await run()
    const b = await run()
    expect(hashState(a.world)).toBe(hashState(b.world))
  })
})

describe('placement occupancy gate', () => {
  /** A plain sink building with one accept slot, footprint w×h anchored at (x, y). */
  const placeSink = (sim: Sim, x: number, y: number, w = 1, h = 1): void =>
    enqueuePlaceBuilding(sim.world, {
      x,
      y,
      w,
      h,
      color: 0x334455,
      accepts: [{ color: SRC, cap: 100 }],
    })

  it('rejects a building whose footprint overlaps another building', async () => {
    const sim = await bootstrapSim(1)
    placeSink(sim, 30, 30)
    sim.scheduler.runTicks(sim.world, 1)
    const first = buildingAt(sim.state.buildings, 30, 30)
    expect(first).toBeGreaterThanOrEqual(0)
    const count = sim.state.buildings.count
    // A second building on the same tile is dropped: the tile still resolves to the first.
    placeSink(sim, 30, 30)
    sim.scheduler.runTicks(sim.world, 1)
    expect(sim.state.buildings.count).toBe(count)
    expect(buildingAt(sim.state.buildings, 30, 30)).toBe(first)
  })

  it('rejects a 2×2 building overlapping an existing footprint by a single corner', async () => {
    const sim = await bootstrapSim(1)
    placeSink(sim, 30, 30, 2, 2) // covers (30,30)…(31,31)
    sim.scheduler.runTicks(sim.world, 1)
    const count = sim.state.buildings.count
    placeSink(sim, 31, 31, 2, 2) // its top-left corner lands on the first's bottom-right — blocked
    sim.scheduler.runTicks(sim.world, 1)
    expect(sim.state.buildings.count).toBe(count)
    expect(buildingAt(sim.state.buildings, 32, 32)).toBe(-1) // nothing spilled onto the new tiles
  })

  it('rejects a building placed on a belt tile', async () => {
    const sim = await bootstrapSim(1)
    enqueuePlaceBelt(sim.world, { ax: 30, ay: 30, bx: 33, by: 30, color: 0x404040, moveEvery: 1 })
    sim.scheduler.runTicks(sim.world, 1)
    const count = sim.state.buildings.count
    placeSink(sim, 31, 30) // squarely on the belt run — blocked
    sim.scheduler.runTicks(sim.world, 1)
    expect(sim.state.buildings.count).toBe(count)
    expect(buildingAt(sim.state.buildings, 31, 30)).toBe(-1)
  })

  it('rejects a crafter overlapping a building', async () => {
    const sim = await bootstrapSim(1)
    placeSink(sim, 30, 30)
    sim.scheduler.runTicks(sim.world, 1)
    const first = buildingAt(sim.state.buildings, 30, 30)
    const count = sim.state.buildings.count
    enqueuePlaceProducer(sim.world, {
      x: 30,
      y: 30,
      w: 1,
      h: 1,
      color: 0x223344,
      itemColor: SRC,
      produceEvery: 5,
      storageCap: 100,
    })
    sim.scheduler.runTicks(sim.world, 1)
    expect(sim.state.buildings.count).toBe(count)
    expect(buildingAt(sim.state.buildings, 30, 30)).toBe(first) // the sink still owns the tile
  })

  it('is deterministic across a sequence including blocked placements', async () => {
    const run = async (): Promise<Sim> => {
      const sim = await bootstrapSim(11)
      placeSink(sim, 30, 30)
      placeSink(sim, 30, 30) // blocked (overlap)
      enqueuePlaceBelt(sim.world, { ax: 32, ay: 30, bx: 35, by: 30, color: 0x404040, moveEvery: 1 })
      placeSink(sim, 33, 30) // blocked (on belt)
      placeSink(sim, 40, 40) // accepted
      sim.scheduler.runTicks(sim.world, 50)
      return sim
    }
    const a = await run()
    const b = await run()
    expect(hashState(a.world)).toBe(hashState(b.world))
  })
})
