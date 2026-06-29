import { describe, it, expect } from 'vitest'
import { entityCount } from '@factory/engine/core'
import { hashState } from '@factory/engine/persistence'
import { bootstrapSim, type Sim } from '../bootstrap.ts'
import { enqueuePlaceBelt, enqueuePlacePort, enqueuePlaceSplitter } from '../gameLogic.ts'

/** village + 6x6 orchard, before anything is placed. */
const BASELINE = 37
/** A horizontal belt of 9 tiles, from (0,0) to (8,0). */
const BELT_LEN = 9

/** Boot a sim and lay one horizontal 9-tile belt at y=0 (moves every tick). */
async function bootWithBelt(seed: number): Promise<Sim> {
  const sim = await bootstrapSim(seed)
  enqueuePlaceBelt(sim.world, { ax: 0, ay: 0, bx: 8, by: 0, color: 0x404040, moveEvery: 1 })
  return sim
}

/**
 * Boot a 9-tile belt with an output at tile A (extract every 4 ticks) and, optionally, an
 * input at tile B that drains it. Commands queued before the first tick apply in order, so
 * the belt exists by the time the ports attach to it.
 */
async function bootFlow(seed: number, ticks: number, withInput: boolean): Promise<Sim> {
  const sim = await bootWithBelt(seed)
  enqueuePlacePort(sim.world, {
    x: 0,
    y: 0,
    port: 'output',
    color: 0x44dd44,
    itemColor: 0xffaa00,
    spawnEvery: 4,
  })
  if (withInput) {
    enqueuePlacePort(sim.world, { x: 8, y: 0, port: 'input', color: 0xdd4444 })
  }
  sim.scheduler.runTicks(sim.world, ticks)
  return sim
}

describe('belt', () => {
  it('is inert without ports: a bare belt never spawns or moves any item', async () => {
    const sim = await bootWithBelt(1)
    sim.scheduler.runTicks(sim.world, 500)
    // One track entity per tile was added; no items appeared.
    expect(entityCount(sim.world)).toBe(BASELINE + BELT_LEN)
  })

  it('is deterministic: same seed + commands -> identical state hash', async () => {
    const a = await bootFlow(7, 200, true)
    const b = await bootFlow(7, 200, true)
    expect(hashState(a.world)).toBe(hashState(b.world))
  })

  it('an output extracts items and an input consumes them, keeping the belt bounded', async () => {
    const sim = await bootFlow(1, 1000, true)
    // Fixed: 9 track tiles + the two port footprints. Items drain at B, so the count
    // stays above the fixtures (something is riding) but well below a full belt.
    const fixed = BASELINE + BELT_LEN + 2
    expect(entityCount(sim.world)).toBeGreaterThan(fixed)
    expect(entityCount(sim.world)).toBeLessThan(fixed + BELT_LEN)
  })

  it('an output with no input backs up and fills every tile, then stops', async () => {
    const sim = await bootFlow(1, 1000, false)
    // 9 tracks + 1 output footprint + one item on every one of the 9 tiles.
    expect(entityCount(sim.world)).toBe(BASELINE + BELT_LEN + 1 + BELT_LEN)
  })

  it('carries items across the join of two separately-drawn collinear belts', async () => {
    // Two runs that meet at (4,0)/(5,0): items must cross the seam, not dead-end.
    const sim = await bootstrapSim(1)
    enqueuePlaceBelt(sim.world, { ax: 0, ay: 0, bx: 4, by: 0, color: 0x404040, moveEvery: 1 })
    enqueuePlaceBelt(sim.world, { ax: 5, ay: 0, bx: 8, by: 0, color: 0x404040, moveEvery: 1 })
    enqueuePlacePort(sim.world, {
      x: 0,
      y: 0,
      port: 'output',
      color: 0x44dd44,
      itemColor: 0xffaa00,
      spawnEvery: 4,
    })
    sim.scheduler.runTicks(sim.world, 1000)
    // If items cross the join, all 9 tiles fill (9 items); the old per-segment model
    // would dead-end at tile 4 and fill only the first 5.
    expect(entityCount(sim.world)).toBe(BASELINE + BELT_LEN + 1 + BELT_LEN)
  })

  it('drops a port placed where no belt exists', async () => {
    const sim = await bootWithBelt(1)
    enqueuePlacePort(sim.world, { x: 100, y: 100, port: 'output', color: 0x44dd44 })
    sim.scheduler.runTicks(sim.world, 10)
    // The off-belt port spawns no footprint and leaves the belt portless (still inert).
    expect(entityCount(sim.world)).toBe(BASELINE + BELT_LEN)
  })

  it('drops a splitter placed where no belt exists', async () => {
    const sim = await bootWithBelt(1)
    enqueuePlaceSplitter(sim.world, { x: 100, y: 100, color: 0x9b59b6 })
    sim.scheduler.runTicks(sim.world, 10)
    expect(entityCount(sim.world)).toBe(BASELINE + BELT_LEN)
  })
})

/**
 * Splitter topology: a 3-tile feed (output at the head) running East into a splitter at
 * (2,0), which fans out to a North branch and a South branch (3 tiles each, no inputs).
 * 9 belt tiles total. With no drains, a working round-robin fills BOTH branches.
 */
async function bootSplitter(seed: number, ticks: number): Promise<Sim> {
  const sim = await bootstrapSim(seed)
  enqueuePlaceBelt(sim.world, { ax: 0, ay: 0, bx: 2, by: 0, color: 0x404040, moveEvery: 1 })
  enqueuePlaceBelt(sim.world, { ax: 2, ay: -1, bx: 2, by: -3, color: 0x404040, moveEvery: 1 })
  enqueuePlaceBelt(sim.world, { ax: 2, ay: 1, bx: 2, by: 3, color: 0x404040, moveEvery: 1 })
  enqueuePlacePort(sim.world, {
    x: 0,
    y: 0,
    port: 'output',
    color: 0x44dd44,
    itemColor: 0xffaa00,
    spawnEvery: 4,
  })
  enqueuePlaceSplitter(sim.world, { x: 2, y: 0, color: 0x9b59b6 })
  sim.scheduler.runTicks(sim.world, ticks)
  return sim
}

describe('splitter', () => {
  it('round-robins arriving items across both branches until everything fills', async () => {
    const sim = await bootSplitter(1, 1000)
    // 9 track tiles + output footprint + splitter footprint + one item on every tile.
    // Reaching 9 items proves BOTH branches were fed (a single-branch bug caps at 6).
    expect(entityCount(sim.world)).toBe(BASELINE + 9 + 2 + 9)
  })

  it('is deterministic with a splitter in the network', async () => {
    const a = await bootSplitter(3, 300)
    const b = await bootSplitter(3, 300)
    expect(hashState(a.world)).toBe(hashState(b.world))
  })
})

describe('belt tiers (per-tile speed)', () => {
  it('derives the base move-cycle as the GCD of tile periods, dueEvery = period / base', async () => {
    const sim = await bootstrapSim(1)
    // An mk1 run (period 60) on y=0 and an mk3 run (period 15) on y=2, laid separately.
    enqueuePlaceBelt(sim.world, { ax: 0, ay: 0, bx: 3, by: 0, color: 0x404040, moveEvery: 60 })
    enqueuePlaceBelt(sim.world, { ax: 0, ay: 2, bx: 3, by: 2, color: 0x404040, moveEvery: 15 })
    sim.scheduler.runTicks(sim.world, 1) // drain the queued placements so the grid is live
    const g = sim.state.grid
    expect(g.moveEvery).toBe(15) // gcd(60, 15)
    // The slow run moves once every 4 base-cycles; the fast run every cycle.
    for (let t = 0; t < g.count; t++) {
      expect(g.dueEvery[t]!).toBe(g.ty[t] === 0 ? 4 : 1)
    }
  })

  it('carries an item further on a faster belt than a slower one in the same time', async () => {
    const sim = await bootstrapSim(1)
    const w = sim.world
    // Two long parallel belts fed by outputs: slow (mk1) on y=0, fast (mk3, 4x) on y=2.
    enqueuePlaceBelt(w, { ax: 0, ay: 0, bx: 30, by: 0, color: 0x404040, moveEvery: 60 })
    enqueuePlaceBelt(w, { ax: 0, ay: 2, bx: 30, by: 2, color: 0x404040, moveEvery: 15 })
    enqueuePlacePort(w, {
      x: 0,
      y: 0,
      port: 'output',
      color: 0x44dd44,
      itemColor: 0xffaa00,
      spawnEvery: 1,
    })
    enqueuePlacePort(w, {
      x: 0,
      y: 2,
      port: 'output',
      color: 0x44dd44,
      itemColor: 0xffaa00,
      spawnEvery: 1,
    })
    sim.scheduler.runTicks(w, 240) // 4 mk1 move-cycles vs 16 mk3 move-cycles
    const g = sim.state.grid
    const { Position } = w.components
    let slowMax = 0
    let fastMax = 0
    for (let t = 0; t < g.count; t++) {
      const eid = g.slot[t]!
      if (eid === -1) continue
      if (g.ty[t] === 0) slowMax = Math.max(slowMax, Position.x[eid]!)
      else fastMax = Math.max(fastMax, Position.x[eid]!)
    }
    // The fast belt's frontier is well ahead of the slow belt's (~4x).
    expect(fastMax).toBeGreaterThan(slowMax)
  })

  it('is deterministic with mixed-speed belts: same seed + commands -> identical hash', async () => {
    const boot = async (): Promise<Sim> => {
      const sim = await bootstrapSim(5)
      enqueuePlaceBelt(sim.world, { ax: 0, ay: 0, bx: 8, by: 0, color: 0x404040, moveEvery: 60 })
      enqueuePlaceBelt(sim.world, { ax: 0, ay: 2, bx: 8, by: 2, color: 0x404040, moveEvery: 30 })
      enqueuePlaceBelt(sim.world, { ax: 0, ay: 4, bx: 8, by: 4, color: 0x404040, moveEvery: 15 })
      for (const y of [0, 2, 4]) {
        enqueuePlacePort(sim.world, {
          x: 0,
          y,
          port: 'output',
          color: 0x44dd44,
          itemColor: 0xffaa00,
          spawnEvery: 4,
        })
      }
      sim.scheduler.runTicks(sim.world, 300)
      return sim
    }
    const a = await boot()
    const b = await boot()
    expect(hashState(a.world)).toBe(hashState(b.world))
  })

  it('items ride the feed belt one tile per cycle into a splitter — they never teleport across it', async () => {
    // Reproduces the on-screen "items jump from the output straight to the splitter" bug:
    // a 6-tile feed belt (output at the head) running East into a splitter at (6,0) that
    // fans out North / East / South. moveEvery:1 means one move-cycle per tick.
    const sim = await bootstrapSim(1)
    const w = sim.world
    enqueuePlaceBelt(w, { ax: 0, ay: 0, bx: 10, by: 0, color: 0x404040, moveEvery: 1 })
    enqueuePlaceBelt(w, { ax: 6, ay: -1, bx: 6, by: -5, color: 0x404040, moveEvery: 1 })
    enqueuePlaceBelt(w, { ax: 6, ay: 1, bx: 6, by: 5, color: 0x404040, moveEvery: 1 })
    enqueuePlacePort(w, {
      x: 0,
      y: 0,
      port: 'output',
      color: 0x44dd44,
      itemColor: 0xffaa00,
      spawnEvery: 4,
    })
    enqueuePlaceSplitter(w, { x: 6, y: 0, color: 0x9b59b6 })

    const { Position } = w.components
    const g = sim.state.grid
    const lastTile = new Map<number, [number, number]>()
    const feedTilesSeen = new Set<number>()

    for (let cycle = 0; cycle < 80; cycle++) {
      sim.scheduler.runTicks(w, 1) // moveEvery:1 -> exactly one move-cycle
      for (let t = 0; t < g.count; t++) {
        const eid = g.slot[t]!
        if (eid === -1) continue
        const x = Position.x[eid]!
        const y = Position.y[eid]!
        const prev = lastTile.get(eid)
        if (prev) {
          // No item may advance more than one tile in a single move-cycle. The teleport bug
          // hopped 7 tiles (output -> splitter) at once; this caps it at one.
          expect(Math.abs(x - prev[0]) + Math.abs(y - prev[1])).toBeLessThanOrEqual(1)
        }
        lastTile.set(eid, [x, y])
        if (y === 0 && x >= 1 && x <= 5) feedTilesSeen.add(x) // an intermediate feed tile carried an item
      }
    }

    // Every intermediate feed tile actually carried an item at some point — proof the belt
    // is traversed tile by tile, not skipped.
    expect([...feedTilesSeen].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5])
  })
})
