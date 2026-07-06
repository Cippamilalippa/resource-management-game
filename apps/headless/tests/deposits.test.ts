import { describe, it, expect } from 'vitest'
import { spawnEntity } from '@factory/engine/core'
import { hashSnapshot } from '@factory/engine/persistence'
import { bootstrapSim, type Sim } from '../bootstrap.ts'
import {
  MAX_SLOTS,
  EXHAUSTED_COLOR,
  RICHNESS_INFINITE,
  TERRAIN_SPRITE,
  buildingAt,
  collectAlerts,
  depositRichnessAt,
  serializeGameState,
  terrainTypeOf,
  tileKey,
  enqueuePlaceProducer,
} from '../gameLogic.ts'

/**
 * G1 — finite deposits with richness. Extraction used to be infinite; now a deposit tile carries a
 * finite richness (rolled by the scene from a per-scenario band) that each completed extraction craft
 * decrements, until the tile EXHAUSTS and its crafter stalls. These cover the invariants that matter:
 * determinism through depletion, the depletion behaviour itself (exhaust → stall → alert → grey-out),
 * a byte-exact save/load round-trip, and backwards-compatible loading of a pre-richness snapshot.
 */

/** A deposit terrain id + the resource its extractor makes (arbitrary distinct colour). */
const DEPOSIT = terrainTypeOf('terrain.bauxite_deposit')
const ORE = 0x9b7a3c
/** The deposit tile the tests plant an extractor on. */
const DX = 10
const DY = 10

/**
 * Hand-build a controlled depleting world on a scene-less origin: paint one deposit tile with a low,
 * fixed richness (+ its terrain render entity so exhaustion can grey it), then place a fast extraction
 * crafter on it. Fully deterministic — no RNG — so two calls with the same seed are byte-identical.
 */
function plantExtractor(sim: Sim, richness: number, produceEvery = 2): number {
  const key = tileKey(DX, DY)
  const eid = spawnEntity(sim.world, {
    pos: { x: DX, y: DY },
    sprite: TERRAIN_SPRITE,
    color: 0xb08d57,
    width: 1,
    height: 1,
  })
  sim.state.terrain.set(key, DEPOSIT)
  sim.state.deposits.remaining.set(key, richness)
  sim.state.deposits.eid.set(key, eid)
  enqueuePlaceProducer(sim.world, {
    x: DX,
    y: DY,
    w: 1,
    h: 1,
    color: 0x778800,
    itemColor: ORE,
    produceEvery,
    storageCap: 1000,
    requiresTerrainType: DEPOSIT,
  })
  sim.scheduler.runTicks(sim.world, 1) // apply the placement
  return eid
}

/** Units the extractor at (DX, DY) has produced into its output slot so far. */
function produced(sim: Sim): number {
  const b = buildingAt(sim.state.buildings, DX, DY)
  return b < 0 ? 0 : sim.state.buildings.slotCount[b * MAX_SLOTS]!
}

describe('finite deposit depletion', () => {
  it('exhausts a low-richness tile and then stalls the extractor', async () => {
    const sim = await bootstrapSim(1, { startScene: false })
    const eid = plantExtractor(sim, 5)
    sim.scheduler.runTicks(sim.world, 60)

    // Exactly the richness (5 units) was extracted, then the tile is spent.
    expect(depositRichnessAt(sim.state.deposits, DX, DY)).toBe(0)
    expect(produced(sim)).toBe(5)
    // The deposit's terrain entity is greyed the moment it exhausts (sim-driven visual).
    expect(sim.world.components.Renderable.color[eid]).toBe(EXHAUSTED_COLOR)

    // Stalled: running further extracts nothing more, and it surfaces as an exhausted-crafter alert.
    sim.scheduler.runTicks(sim.world, 120)
    expect(produced(sim)).toBe(5)
    expect(collectAlerts(sim.state)).toContainEqual({ kind: 'crafter_exhausted', x: DX, y: DY })
  })

  it('is deterministic across two runs that both deplete during the run (same seed → same hash)', async () => {
    const run = async (): Promise<Sim> => {
      const sim = await bootstrapSim(99, { startScene: false })
      plantExtractor(sim, 8)
      sim.scheduler.runTicks(sim.world, 200)
      return sim
    }
    const a = await run()
    const b = await run()
    // Depletion actually happened (not a vacuous all-infinite run).
    expect(depositRichnessAt(a.state.deposits, DX, DY)).toBe(0)
    expect(serializeGameState(a.state)).toEqual(serializeGameState(b.state))
    expect(hashSnapshot(a.serialize())).toBe(hashSnapshot(b.serialize()))
  })

  it('the scene rolls finite richness for a finite scenario (abundant), sized to its deposits', async () => {
    const sim = await bootstrapSim(7, { scenario: 'scenario.abundant' })
    // Every deposit tile got a richness within the scenario band, and there are as many as tiles.
    expect(sim.state.deposits.remaining.size).toBe(sim.state.terrain.size)
    for (const units of sim.state.deposits.remaining.values()) {
      expect(units).toBeGreaterThanOrEqual(1200)
      expect(units).toBeLessThanOrEqual(2400)
    }
  })
})

describe('finite deposit persistence', () => {
  it('round-trips richness (and exhausted state) with a preserved hash', async () => {
    const src = await bootstrapSim(3, { startScene: false })
    plantExtractor(src, 20)
    // Deplete partway (some, not all) so both remaining richness and accrued output are mid-state.
    src.scheduler.runTicks(src.world, 10)
    const remainingMid = depositRichnessAt(src.state.deposits, DX, DY)
    expect(remainingMid).toBeGreaterThan(0)
    expect(remainingMid).toBeLessThan(20)

    const snap = src.serialize()
    const dst = await bootstrapSim(3, { startScene: false })
    dst.restore(snap)

    expect(hashSnapshot(dst.serialize())).toBe(hashSnapshot(snap))
    expect(serializeGameState(dst.state)).toEqual(serializeGameState(src.state))
    expect(depositRichnessAt(dst.state.deposits, DX, DY)).toBe(remainingMid)

    // A loaded save keeps depleting from where it left off and reaches the same exhausted state.
    src.scheduler.runTicks(src.world, 120)
    dst.scheduler.runTicks(dst.world, 120)
    expect(depositRichnessAt(dst.state.deposits, DX, DY)).toBe(0)
    expect(hashSnapshot(dst.serialize())).toBe(hashSnapshot(src.serialize()))
  })

  it('loads a pre-richness snapshot as infinite (legacy extractor never depletes)', async () => {
    const src = await bootstrapSim(5, { startScene: false })
    plantExtractor(src, 6)
    src.scheduler.runTicks(src.world, 10)
    const snap = src.serialize()

    // Simulate an old save: drop the additive `deposits` field and every building's cached anchorKey.
    const base = (snap.modState as { base: Record<string, unknown> }).base
    delete base.deposits
    for (const b of base.buildings as Array<Record<string, unknown>>) delete b.anchorKey

    const dst = await bootstrapSim(5, { startScene: false })
    dst.restore(snap)

    // With no richness data the deposit is infinite and the extractor is not depletion-linked.
    expect(depositRichnessAt(dst.state.deposits, DX, DY)).toBe(RICHNESS_INFINITE)
    const before = produced(dst)
    dst.scheduler.runTicks(dst.world, 200)
    // It just keeps producing — the original infinite-extraction behaviour is preserved.
    expect(produced(dst)).toBeGreaterThan(before)
  })
})
