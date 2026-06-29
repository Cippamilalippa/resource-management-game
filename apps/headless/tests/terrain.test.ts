import { describe, it, expect } from 'vitest'
import { hashState } from '@factory/engine/persistence'
import { bootstrapSim, type Sim } from '../bootstrap.ts'
import { buildingAt, enqueuePlaceProducer, terrainTypeOf, type GameState } from '../gameLogic.ts'

/** The fertile-soil patch the starting scene paints (corner 8,-3, 5x5). */
const FERTILE_X = 8
const FERTILE_Y = -3
const FERTILE = terrainTypeOf('terrain.fertile_soil')
const FOREST = terrainTypeOf('terrain.forest')

/** Whether a registered producer building (one that produces a resource) sits at (x, y). */
function isProducer(state: GameState, x: number, y: number): boolean {
  const b = buildingAt(state.buildings, x, y)
  return b >= 0 && state.buildings.prodColor[b]! >= 0
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
    placeFarm(sim, FERTILE_X, FERTILE_Y, FERTILE)
    expect(isProducer(sim.state, FERTILE_X, FERTILE_Y)).toBe(true)
  })

  it('drops a producer whose required terrain does not match the ground', async () => {
    const sim = await bootstrapSim(1)
    // The tile is fertile soil, but this producer demands forest — it must be rejected.
    placeFarm(sim, FERTILE_X, FERTILE_Y, FOREST)
    expect(isProducer(sim.state, FERTILE_X, FERTILE_Y)).toBe(false)
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
      placeFarm(sim, FERTILE_X, FERTILE_Y, FERTILE)
      sim.scheduler.runTicks(sim.world, 300)
      return hashState(sim.world)
    }
    expect(await run()).toBe(await run())
  })
})
