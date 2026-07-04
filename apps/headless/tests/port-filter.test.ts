import { describe, it, expect } from 'vitest'
import { hashState, hashSnapshot } from '@factory/engine/persistence'
import { bootstrapSim, type Sim } from '../bootstrap.ts'
import {
  enqueuePlaceBelt,
  enqueuePlaceBuilding,
  enqueuePlaceCrafter,
  enqueuePlacePort,
  enqueueSetPortFilter,
  serializeGameState,
  buildingAt,
  MAX_SLOTS,
  FILTER_WHITELIST,
  FILTER_BLACKLIST,
} from '../gameLogic.ts'

/**
 * Port colour filters (the multi-output routing feature). A crafter with two products can't be
 * split by a bare output port — it drains the first non-empty slot regardless of colour — so a
 * mixed line clogs the wrong consumer. A filter fixes that: an output port drains only the colours
 * it admits, an input port ingests only such items. These tests build on an EMPTY world so the
 * network (and its hashes) are exact.
 */
const A = 0x00ff00 // "kerosene"
const B = 0xff0000 // "naphtha"

/**
 * Build a two-output machine at (0,0) making one A + one B per tick, an east belt to a sink that
 * accepts BOTH colours, and an output port draining the machine. The sink-accepts-both is the crux:
 * only the port's filter decides what reaches it, so a wrong colour in the sink means a broken filter.
 */
async function bootSplit(seed: number): Promise<Sim> {
  const sim = await bootstrapSim(seed, { startScene: false })
  const w = sim.world
  enqueuePlaceCrafter(w, {
    x: 0,
    y: 0,
    w: 1,
    h: 1,
    color: 0x223344,
    recipe: 1,
    inputs: [],
    outputs: [
      { color: A, amount: 1 },
      { color: B, amount: 1 },
    ],
    craftEvery: 1,
    storageCap: 1_000_000,
  })
  enqueuePlaceBuilding(w, {
    x: 7,
    y: 0,
    w: 1,
    h: 1,
    color: 0x334455,
    accepts: [
      { color: A, cap: 1_000_000 },
      { color: B, cap: 1_000_000 },
    ],
  })
  enqueuePlaceBelt(w, { ax: 1, ay: 0, bx: 6, by: 0, color: 0x404040, moveEvery: 1 })
  enqueuePlacePort(w, { x: 1, y: 0, port: 'output', color: 0x44dd44, spawnEvery: 1 })
  enqueuePlacePort(w, { x: 6, y: 0, port: 'input', color: 0xdd4444 })
  // Deliberately do NOT tick here: the caller enqueues its filter next, so placements and the
  // filter land in the same command batch — the port is filtered before it ever drains a unit.
  return sim
}

/** Count of `color` in the sink at (7,0). */
function sinkCount(sim: Sim, color: number): number {
  const b = buildingAt(sim.state.buildings, 7, 0)
  const bs = sim.state.buildings
  for (let k = 0; k < bs.slotN[b]!; k++) {
    const i = b * MAX_SLOTS + k
    if (bs.slotColor[i] === color) return bs.slotCount[i]!
  }
  return 0
}

describe('port colour filters', () => {
  it('a whitelisted output port drains only its colour off a multi-output machine', async () => {
    const sim = await bootSplit(1)
    // Whitelist B: the port must skip A (slot 0) — which a bare port would drain first — and pull B.
    enqueueSetPortFilter(sim.world, { x: 1, y: 0, mode: FILTER_WHITELIST, colors: [B] })
    sim.scheduler.runTicks(sim.world, 300)
    expect(sinkCount(sim, B)).toBeGreaterThan(0)
    expect(sinkCount(sim, A)).toBe(0) // A never leaves the machine — the filter routed by colour
  })

  it('a blacklisted output port drains everything except its colour', async () => {
    const sim = await bootSplit(2)
    enqueueSetPortFilter(sim.world, { x: 1, y: 0, mode: FILTER_BLACKLIST, colors: [B] })
    sim.scheduler.runTicks(sim.world, 300)
    expect(sinkCount(sim, A)).toBeGreaterThan(0)
    expect(sinkCount(sim, B)).toBe(0)
  })

  it('an unfiltered output port drains the first slot only, so A blocks B (the bug filters fix)', async () => {
    const sim = await bootSplit(3)
    // No filter: the port keeps draining A (slot 0), and B piles up unrouted in the machine.
    sim.scheduler.runTicks(sim.world, 300)
    expect(sinkCount(sim, A)).toBeGreaterThan(0)
    expect(sinkCount(sim, B)).toBe(0)
    const m = buildingAt(sim.state.buildings, 0, 0)
    expect(sim.state.buildings.slotCount[m * MAX_SLOTS + 1]!).toBeGreaterThan(0) // B stuck in the machine
  })

  it('a whitelisted input port rejects items it does not admit (they back the belt up)', async () => {
    const sim = await bootSplit(4)
    // Output stays unfiltered (drains A), but the INPUT only admits B → nothing is deposited.
    enqueueSetPortFilter(sim.world, { x: 6, y: 0, mode: FILTER_WHITELIST, colors: [B] })
    sim.scheduler.runTicks(sim.world, 300)
    expect(sinkCount(sim, A)).toBe(0)
    expect(sinkCount(sim, B)).toBe(0)
  })

  it('is deterministic: same seed + filters -> identical hash', async () => {
    const run = async (): Promise<Sim> => {
      const sim = await bootSplit(7)
      enqueueSetPortFilter(sim.world, { x: 1, y: 0, mode: FILTER_WHITELIST, colors: [B] })
      sim.scheduler.runTicks(sim.world, 500)
      return sim
    }
    const a = await run()
    const b = await run()
    expect(sinkCount(a, B)).toBeGreaterThan(0)
    expect(hashState(a.world)).toBe(hashState(b.world))
    expect(hashSnapshot(a.serialize())).toBe(hashSnapshot(b.serialize()))
  })

  it('round-trips a filtered port through save/load, and it still routes after reload', async () => {
    const src = await bootSplit(9)
    enqueueSetPortFilter(src.world, { x: 1, y: 0, mode: FILTER_WHITELIST, colors: [B] })
    src.scheduler.runTicks(src.world, 200)

    const dst = await bootstrapSim(9, { startScene: false })
    dst.restore(src.serialize())
    expect(serializeGameState(dst.state)).toEqual(serializeGameState(src.state))
    expect(hashSnapshot(dst.serialize())).toBe(hashSnapshot(src.serialize()))

    // The restored filter keeps routing B only.
    const beforeA = sinkCount(dst, A)
    dst.scheduler.runTicks(dst.world, 200)
    expect(sinkCount(dst, B)).toBeGreaterThan(0)
    expect(sinkCount(dst, A)).toBe(beforeA) // still zero A after reload
  })
})
