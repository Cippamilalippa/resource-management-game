import { describe, it, expect } from 'vitest'
import { entityCount } from '@factory/engine/core'
import { serialize } from '@factory/engine/persistence'
import { TERRAIN_SPRITE, terrainTypeOf, tileKey } from '../gameLogic.ts'
import { bootstrapSim } from '../bootstrap.ts'

/** Total terrain tiles the starting scene paints (two 5x5 + two 4x4 patches). */
const TERRAIN_TILES = 5 * 5 + 5 * 5 + 4 * 4 + 4 * 4

describe('starting scene', () => {
  it('spawns the village + terrain patches + a 6x6 apple orchard', async () => {
    const { world } = await bootstrapSim(1)
    // 1 village + 82 terrain tiles + 6*6 apple trees.
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

  it('paints the four terrain patches as flat-fill tiles and records them in the terrain grid', async () => {
    const { world, state } = await bootstrapSim(1)
    const { entities } = serialize(world)
    const terrain = entities.filter((e) => e.sprite === TERRAIN_SPRITE)
    expect(terrain).toHaveLength(TERRAIN_TILES)
    // The terrain grid is populated for every painted tile (so producer placement can read it).
    expect(state.terrain.size).toBe(TERRAIN_TILES)

    // Spot-check that the fertile-soil patch (corner 8,-3) carries the right terrain type.
    const fertile = terrainTypeOf('terrain.fertile_soil')
    expect(state.terrain.get(tileKey(8, -3))).toBe(fertile)
    expect(state.terrain.get(tileKey(12, 1))).toBe(fertile)
  })
})
