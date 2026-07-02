import { describe, it, expect } from 'vitest'
import { entityCount } from '@factory/engine/core'
import { serialize } from '@factory/engine/persistence'
import { TERRAIN_SPRITE, terrainTypeOf, tileKey } from '../gameLogic.ts'
import { bootstrapSim } from '../bootstrap.ts'

/** Total terrain tiles the starting scene paints (six 4x4 deposit patches). */
const TERRAIN_TILES = 4 * 4 * 6

describe('starting scene', () => {
  it('spawns the spaceport + terrain patches + a 6x6 apple orchard', async () => {
    const { world } = await bootstrapSim(1)
    // 1 spaceport + 96 terrain tiles + 6*6 apple trees.
    expect(entityCount(world)).toBe(1 + TERRAIN_TILES + 36)
  })

  it('places a single 2x2 village centered on the origin', async () => {
    const { world } = await bootstrapSim(1)
    const { entities } = serialize(world)
    const villages = entities.filter((e) => e.width === 2 && e.height === 2)
    expect(villages).toHaveLength(1)
    // 2x2 centered on the origin has its top-left at (-1, -1).
    expect(villages[0]).toMatchObject({ x: -1, y: -1 })
  })

  it('fills a 6x6 square of 1x1 apple trees with its corner at (50, 50)', async () => {
    const { world } = await bootstrapSim(1)
    const { entities } = serialize(world)
    // Trees are 1x1 with the default rect glyph (sprite 0); terrain tiles use TERRAIN_SPRITE.
    const trees = entities.filter((e) => e.width === 1 && e.height === 1 && e.sprite === 0)
    expect(trees).toHaveLength(36)
    for (const t of trees) {
      expect(t.x).toBeGreaterThanOrEqual(50)
      expect(t.x).toBeLessThanOrEqual(55)
      expect(t.y).toBeGreaterThanOrEqual(50)
      expect(t.y).toBeLessThanOrEqual(55)
    }
    // Every tile in the 6x6 area is present exactly once.
    const cells = new Set(trees.map((t) => `${t.x},${t.y}`))
    expect(cells.size).toBe(36)
  })

  it('paints the six terrain patches as flat-fill tiles and records them in the terrain grid', async () => {
    const { world, state } = await bootstrapSim(1)
    const { entities } = serialize(world)
    const terrain = entities.filter((e) => e.sprite === TERRAIN_SPRITE)
    expect(terrain).toHaveLength(TERRAIN_TILES)
    // The terrain grid is populated for every painted tile (so producer placement can read it).
    expect(state.terrain.size).toBe(TERRAIN_TILES)

    // Spot-check that the bauxite patch (4x4 at corner 8,-3) carries the right terrain type.
    const bauxite = terrainTypeOf('terrain.bauxite_deposit')
    expect(state.terrain.get(tileKey(8, -3))).toBe(bauxite)
    expect(state.terrain.get(tileKey(11, 0))).toBe(bauxite)
  })
})
