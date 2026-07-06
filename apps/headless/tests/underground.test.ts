import { describe, it, expect } from 'vitest'
import { hashSnapshot } from '@factory/engine/persistence'
import { bootstrapSim, type Sim } from '../bootstrap.ts'
import {
  MAX_SLOTS,
  KIND_PLAIN,
  KIND_UNDER_IN,
  KIND_UNDER_OUT,
  UNDERGROUND_MAX_SPAN,
  buildingAt,
  serializeGameState,
  enqueuePlaceBelt,
  enqueuePlaceBuilding,
  enqueuePlaceProducer,
  enqueuePlacePort,
  enqueuePlaceUnderground,
  enqueueRemove,
} from '../gameLogic.ts'

/**
 * Underground belts (improvement-plan L1): an entrance/exit cap pair that carries items under the gap
 * between them — crossing other belts/buildings — with back-pressure intact. These tests build their
 * own networks on an EMPTY world (`startScene: false`) so entity counts and tile lookups are exact.
 */

/** Resource the tunnel source makes / its sink accepts. */
const SRC = 0xffaa00
/** A second resource for the crossing belt, distinct from {@link SRC}. */
const CROSS = 0x00ffcc
/** The underground caps' belt colour. */
const UNDER = 0x4fb0a0
const HUGE = 1_000_000

/** The dense belt-tile id at (x, y), or -1. Recompute after any placement/removal applies. */
function tileAt(sim: Sim, x: number, y: number): number {
  const g = sim.state.grid
  for (let t = 0; t < g.count; t++) if (g.tx[t]! === x && g.ty[t]! === y) return t
  return -1
}

/** Units of the sink building at (x, y)'s first slot. */
function sinkStock(sim: Sim, x: number, y: number): number {
  const b = buildingAt(sim.state.buildings, x, y)
  return b < 0 ? 0 : sim.state.buildings.slotCount[b * MAX_SLOTS]!
}

describe('underground belt — traversal', () => {
  it('carries items from the entrance to the exit across an empty gap and on to a sink', async () => {
    const sim = await bootstrapSim(1, { startScene: false })
    const w = sim.world
    // Feed tile (the output sits on it) and the exit's downstream belt (the input sits on it).
    enqueuePlaceBelt(w, { ax: 1, ay: 0, bx: 1, by: 0, color: 0x404040, moveEvery: 1 })
    enqueuePlaceBelt(w, { ax: 7, ay: 0, bx: 7, by: 0, color: 0x404040, moveEvery: 1 })
    enqueuePlaceProducer(w, {
      x: 0,
      y: 0,
      w: 1,
      h: 1,
      color: 0x223344,
      itemColor: SRC,
      produceEvery: 1,
      storageCap: HUGE,
    })
    enqueuePlacePort(w, { x: 1, y: 0, port: 'output', color: 0x44dd44, spawnEvery: 2 })
    enqueuePlaceBuilding(w, {
      x: 8,
      y: 0,
      w: 1,
      h: 1,
      color: 0x334455,
      accepts: [{ color: SRC, cap: HUGE }],
    })
    enqueuePlacePort(w, { x: 7, y: 0, port: 'input', color: 0xdd4444 })
    // Tunnel over the empty gap tiles (3,0)/(4,0)/(5,0): entrance (2,0) -> exit (6,0), span 4.
    enqueuePlaceUnderground(w, { x: 2, y: 0, ex: 6, ey: 0, dir: 1, color: UNDER, moveEvery: 1 })
    sim.scheduler.runTicks(w, 1) // apply the queued placements

    expect(sim.state.grid.kind[tileAt(sim, 2, 0)]!).toBe(KIND_UNDER_IN)
    expect(sim.state.grid.kind[tileAt(sim, 6, 0)]!).toBe(KIND_UNDER_OUT)
    // No belt tile sits in the gap — the tunnel genuinely bridges empty ground.
    expect(tileAt(sim, 4, 0)).toBe(-1)

    sim.scheduler.runTicks(w, 120)
    expect(sinkStock(sim, 8, 0)).toBeGreaterThan(0)
  })

  it('is deterministic: same seed + a tunnel network -> identical snapshot hash', async () => {
    const boot = async (): Promise<Sim> => {
      const sim = await bootstrapSim(5, { startScene: false })
      const w = sim.world
      enqueuePlaceBelt(w, { ax: 1, ay: 0, bx: 1, by: 0, color: 0x404040, moveEvery: 1 })
      enqueuePlaceBelt(w, { ax: 7, ay: 0, bx: 7, by: 0, color: 0x404040, moveEvery: 1 })
      enqueuePlaceProducer(w, {
        x: 0,
        y: 0,
        w: 1,
        h: 1,
        color: 0x223344,
        itemColor: SRC,
        produceEvery: 1,
        storageCap: HUGE,
      })
      enqueuePlacePort(w, { x: 1, y: 0, port: 'output', color: 0x44dd44, spawnEvery: 3 })
      enqueuePlaceBuilding(w, {
        x: 8,
        y: 0,
        w: 1,
        h: 1,
        color: 0x334455,
        accepts: [{ color: SRC, cap: HUGE }],
      })
      enqueuePlacePort(w, { x: 7, y: 0, port: 'input', color: 0xdd4444 })
      enqueuePlaceUnderground(w, { x: 2, y: 0, ex: 6, ey: 0, dir: 1, color: UNDER, moveEvery: 1 })
      sim.scheduler.runTicks(w, 400)
      return sim
    }
    const a = await boot()
    const b = await boot()
    expect(hashSnapshot(a.serialize())).toBe(hashSnapshot(b.serialize()))
  })
})

describe('underground belt — back-pressure', () => {
  it('a blocked exit stalls the entrance and backs the belt behind it up', async () => {
    const sim = await bootstrapSim(1, { startScene: false })
    const w = sim.world
    // A 5-tile feed belt; (5,0) becomes the entrance, the exit (8,0) faces into empty ground so it
    // can never hand its item on — a dead-end that must back the whole line up.
    enqueuePlaceBelt(w, { ax: 1, ay: 0, bx: 5, by: 0, color: 0x404040, moveEvery: 1 })
    enqueuePlaceProducer(w, {
      x: 0,
      y: 0,
      w: 1,
      h: 1,
      color: 0x223344,
      itemColor: SRC,
      produceEvery: 1,
      storageCap: HUGE,
    })
    enqueuePlacePort(w, { x: 1, y: 0, port: 'output', color: 0x44dd44, spawnEvery: 1 })
    enqueuePlaceUnderground(w, { x: 5, y: 0, ex: 8, ey: 0, dir: 1, color: UNDER, moveEvery: 1 })
    sim.scheduler.runTicks(w, 200)

    const g = sim.state.grid
    // Every feed tile (1..4), the entrance (5) and the dead-ended exit (8) hold an item — the block
    // propagated all the way back up the belt behind the entrance.
    for (const x of [1, 2, 3, 4, 5, 8]) {
      expect(g.slot[tileAt(sim, x, 0)]!).not.toBe(-1)
    }

    // The stall holds: another 200 ticks leaves every tile still occupied (the belt stays jammed
    // behind the dead-ended exit rather than draining), and no item ever escapes past the exit.
    sim.scheduler.runTicks(w, 200)
    for (const x of [1, 2, 3, 4, 5, 8]) {
      expect(g.slot[tileAt(sim, x, 0)]!).not.toBe(-1)
    }
    // The exit dead-ends into empty ground, so nothing can sit one tile beyond it.
    expect(tileAt(sim, 9, 0)).toBe(-1)
  })
})

describe('underground belt — crossing', () => {
  it('a belt crossing a mid-tunnel tile carries its own items without touching the tunnel', async () => {
    const sim = await bootstrapSim(1, { startScene: false })
    const w = sim.world
    // Tunnel line on y=0 (entrance (2,0) -> exit (6,0)), feeding a sink at (8,0).
    enqueuePlaceBelt(w, { ax: 1, ay: 0, bx: 1, by: 0, color: 0x404040, moveEvery: 1 })
    enqueuePlaceBelt(w, { ax: 7, ay: 0, bx: 7, by: 0, color: 0x404040, moveEvery: 1 })
    enqueuePlaceProducer(w, {
      x: 0,
      y: 0,
      w: 1,
      h: 1,
      color: 0x223344,
      itemColor: SRC,
      produceEvery: 1,
      storageCap: HUGE,
    })
    enqueuePlacePort(w, { x: 1, y: 0, port: 'output', color: 0x44dd44, spawnEvery: 2 })
    enqueuePlaceBuilding(w, {
      x: 8,
      y: 0,
      w: 1,
      h: 1,
      color: 0x334455,
      accepts: [{ color: SRC, cap: HUGE }],
    })
    enqueuePlacePort(w, { x: 7, y: 0, port: 'input', color: 0xdd4444 })
    enqueuePlaceUnderground(w, { x: 2, y: 0, ex: 6, ey: 0, dir: 1, color: UNDER, moveEvery: 1 })

    // A vertical belt crossing the gap through (4,0), with its own producer + sink (CROSS colour).
    enqueuePlaceBelt(w, { ax: 4, ay: -3, bx: 4, by: 3, color: 0x505050, moveEvery: 1 })
    enqueuePlaceProducer(w, {
      x: 4,
      y: -4,
      w: 1,
      h: 1,
      color: 0x443322,
      itemColor: CROSS,
      produceEvery: 1,
      storageCap: HUGE,
    })
    enqueuePlacePort(w, { x: 4, y: -3, port: 'output', color: 0x44dd44, spawnEvery: 2, dir: 2 })
    enqueuePlaceBuilding(w, {
      x: 4,
      y: 4,
      w: 1,
      h: 1,
      color: 0x556677,
      accepts: [{ color: CROSS, cap: HUGE }],
    })
    enqueuePlacePort(w, { x: 4, y: 3, port: 'input', color: 0xdd4444, dir: 2 })
    sim.scheduler.runTicks(w, 1)

    const g = sim.state.grid
    const inT = tileAt(sim, 2, 0)
    const outT = tileAt(sim, 6, 0)
    const midT = tileAt(sim, 4, 0)
    const color = w.components.Renderable.color
    let tunnelCarriedCross = false
    let crossingCarriedTunnel = false
    for (let i = 0; i < 150; i++) {
      sim.scheduler.runTicks(w, 1)
      for (const t of [inT, outT]) {
        const e = g.slot[t]!
        if (e !== -1 && color[e]! === CROSS) tunnelCarriedCross = true
      }
      const em = g.slot[midT]!
      if (em !== -1 && color[em]! === SRC) crossingCarriedTunnel = true
    }
    // Neither stream ever leaked onto the other, and both sinks filled with their own resource.
    expect(tunnelCarriedCross).toBe(false)
    expect(crossingCarriedTunnel).toBe(false)
    expect(sinkStock(sim, 8, 0)).toBeGreaterThan(0)
    expect(sinkStock(sim, 4, 4)).toBeGreaterThan(0)
  })
})

describe('underground belt — placement & removal', () => {
  it('rejects an off-axis, over-long, or reversed span (nothing placed)', async () => {
    const sim = await bootstrapSim(1, { startScene: false })
    const w = sim.world
    // Off-axis (exit not on the facing axis).
    enqueuePlaceUnderground(w, { x: 0, y: 0, ex: 3, ey: 1, dir: 1, color: UNDER, moveEvery: 1 })
    // Over-long (span > UNDERGROUND_MAX_SPAN).
    enqueuePlaceUnderground(w, {
      x: 0,
      y: 5,
      ex: UNDERGROUND_MAX_SPAN + 1,
      ey: 5,
      dir: 1,
      color: UNDER,
      moveEvery: 1,
    })
    // Reversed (exit behind the entrance for the given facing).
    enqueuePlaceUnderground(w, { x: 5, y: 10, ex: 2, ey: 10, dir: 1, color: UNDER, moveEvery: 1 })
    sim.scheduler.runTicks(w, 1)
    expect(sim.state.grid.count).toBe(0)
  })

  it('removing either cap breaks the tunnel, demoting its partner to a plain belt', async () => {
    const sim = await bootstrapSim(1, { startScene: false })
    const w = sim.world
    enqueuePlaceUnderground(w, { x: 2, y: 0, ex: 6, ey: 0, dir: 1, color: UNDER, moveEvery: 1 })
    sim.scheduler.runTicks(w, 1)
    const g = sim.state.grid
    expect(g.kind[tileAt(sim, 2, 0)]!).toBe(KIND_UNDER_IN)
    expect(g.kind[tileAt(sim, 6, 0)]!).toBe(KIND_UNDER_OUT)

    // Remove the entrance: it goes, and the exit survives as an ordinary belt (kind plain, unpaired).
    enqueueRemove(w, { x: 2, y: 0 })
    sim.scheduler.runTicks(w, 1)
    expect(tileAt(sim, 2, 0)).toBe(-1)
    const ex = tileAt(sim, 6, 0)
    expect(ex).not.toBe(-1)
    expect(g.kind[ex]!).toBe(KIND_PLAIN)
    expect(g.partner[ex]!).toBe(-1)

    // Removing the (now plain) far end clears the grid entirely.
    enqueueRemove(w, { x: 6, y: 0 })
    sim.scheduler.runTicks(w, 1)
    expect(g.count).toBe(0)
  })

  it('removing the exit first demotes the entrance symmetrically', async () => {
    const sim = await bootstrapSim(1, { startScene: false })
    const w = sim.world
    enqueuePlaceUnderground(w, { x: 3, y: 4, ex: 3, ey: 8, dir: 2, color: UNDER, moveEvery: 1 })
    sim.scheduler.runTicks(w, 1)
    const g = sim.state.grid
    enqueueRemove(w, { x: 3, y: 8 })
    sim.scheduler.runTicks(w, 1)
    expect(tileAt(sim, 3, 8)).toBe(-1)
    const inT = tileAt(sim, 3, 4)
    expect(inT).not.toBe(-1)
    expect(g.kind[inT]!).toBe(KIND_PLAIN)
    expect(g.partner[inT]!).toBe(-1)
  })
})

describe('underground belt — persistence', () => {
  it('round-trips a live tunnel: restore reproduces the exact hash and mod-state blob', async () => {
    const build = (sim: Sim): void => {
      const w = sim.world
      // A tunnel with live traffic, clear of the origin scene's village.
      enqueuePlaceBelt(w, { ax: 20, ay: 20, bx: 20, by: 20, color: 0x404040, moveEvery: 2 })
      enqueuePlaceBelt(w, { ax: 26, ay: 20, bx: 26, by: 20, color: 0x404040, moveEvery: 2 })
      enqueuePlaceProducer(w, {
        x: 19,
        y: 20,
        w: 1,
        h: 1,
        color: 0x223344,
        itemColor: SRC,
        produceEvery: 4,
        storageCap: HUGE,
      })
      enqueuePlacePort(w, { x: 20, y: 20, port: 'output', color: 0x44dd44, spawnEvery: 3 })
      enqueuePlaceBuilding(w, {
        x: 27,
        y: 20,
        w: 1,
        h: 1,
        color: 0x334455,
        accepts: [{ color: SRC, cap: HUGE }],
      })
      enqueuePlacePort(w, { x: 26, y: 20, port: 'input', color: 0xdd4444 })
      enqueuePlaceUnderground(w, {
        x: 21,
        y: 20,
        ex: 25,
        ey: 20,
        dir: 1,
        color: UNDER,
        moveEvery: 2,
      })
    }

    const src = await bootstrapSim(7)
    build(src)
    src.scheduler.runTicks(src.world, 300)
    const snap = src.serialize()

    const dst = await bootstrapSim(7, { startScene: false })
    dst.restore(snap)

    expect(hashSnapshot(dst.serialize())).toBe(hashSnapshot(snap))
    expect(serializeGameState(dst.state)).toEqual(serializeGameState(src.state))

    // Sanity: a restored tunnel cap kept its partner link (so the round-trip really exercised it).
    const g = dst.state.grid
    let paired = false
    for (let t = 0; t < g.count; t++) {
      if ((g.kind[t]! === KIND_UNDER_IN || g.kind[t]! === KIND_UNDER_OUT) && g.partner[t]! >= 0) {
        paired = true
      }
    }
    expect(paired).toBe(true)
  })
})
