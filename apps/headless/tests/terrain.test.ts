import { describe, it, expect } from 'vitest'
import { hashState } from '@factory/engine/persistence'
import { bootstrapSim, type Sim } from '../bootstrap.ts'
import {
  buildingAt,
  enqueuePlaceProducer,
  terrainTypeAt,
  terrainTypeOf,
  type GameState,
} from '../gameLogic.ts'

const FERTILE = terrainTypeOf('terrain.bauxite_deposit')
const FOREST = terrainTypeOf('terrain.titanium_deposit')

/**
 * Find the first tile of a given terrain type in the (deterministic, seed-scattered) starting
 * scene, scanning a bounded window around the origin. The procedural scene keeps every patch within
 * the scenario's spread band, so this window covers them all; the scan order is fixed, so the tile
 * it returns is stable for a given seed.
 */
function findTerrain(sim: Sim, type: number): { x: number; y: number } {
  for (let y = -40; y <= 40; y++) {
    for (let x = -40; x <= 40; x++) {
      if (terrainTypeAt(sim.state.terrain, x, y) === type) return { x, y }
    }
  }
  throw new Error(`no terrain of type ${type} in the scene`)
}

/** Whether a registered crafter building (one that runs a recipe) sits at (x, y). */
function isProducer(state: GameState, x: number, y: number): boolean {
  const b = buildingAt(state.buildings, x, y)
  return b >= 0 && state.buildings.crafts[b]! === 1
}

/** Drop a terrain-gated producer building on the tile (x, y). Producers no longer need a belt. */
function placeFarm(sim: Sim, x: number, y: number, requiresTerrain: number): void {
  enqueuePlaceProducer(sim.world, {
    x,
    y,
    w: 1,
    h: 1,
    color: 0x7ba05b,
    itemColor: 0xe8c95b,
    produceEvery: 30,
    storageCap: 100,
    requiresTerrainType: requiresTerrain,
  })
  sim.scheduler.runTicks(sim.world, 1)
}

describe('terrain gating', () => {
  it('places a producer on matching terrain', async () => {
    const sim = await bootstrapSim(1)
    const { x, y } = findTerrain(sim, FERTILE)
    placeFarm(sim, x, y, FERTILE)
    expect(isProducer(sim.state, x, y)).toBe(true)
  })

  it('drops a producer whose required terrain does not match the ground', async () => {
    const sim = await bootstrapSim(1)
    // The tile is a bauxite deposit, but this producer demands titanium — it must be rejected.
    const { x, y } = findTerrain(sim, FERTILE)
    placeFarm(sim, x, y, FOREST)
    expect(isProducer(sim.state, x, y)).toBe(false)
  })

  it('drops a terrain-gated producer placed on bare ground (no terrain at all)', async () => {
    const sim = await bootstrapSim(1)
    // y = 40 is far from every terrain patch: a fertile-requiring farm cannot take hold.
    placeFarm(sim, 0, 40, FERTILE)
    expect(isProducer(sim.state, 0, 40)).toBe(false)
  })

  it('still places an unrestricted producer (no requirement) on bare ground', async () => {
    const sim = await bootstrapSim(1)
    // Omitting requiresTerrainType keeps the "place anywhere" behaviour.
    enqueuePlaceProducer(sim.world, {
      x: 0,
      y: 40,
      w: 1,
      h: 1,
      color: 0xd7c4c3,
      itemColor: 0xf6d600,
      produceEvery: 30,
      storageCap: 100,
    })
    sim.scheduler.runTicks(sim.world, 1)
    expect(isProducer(sim.state, 0, 40)).toBe(true)
  })

  it('is deterministic: same seed + same placements + ticks -> identical hash', async () => {
    const run = async (): Promise<string> => {
      const sim = await bootstrapSim(5)
      const { x, y } = findTerrain(sim, FERTILE)
      placeFarm(sim, x, y, FERTILE)
      sim.scheduler.runTicks(sim.world, 300)
      return hashState(sim.world)
    }
    expect(await run()).toBe(await run())
  })
})
