import { describe, it, expect } from 'vitest'
import { entityCount } from '@factory/engine/core'
import { serialize } from '@factory/engine/persistence'
import { bootstrapSim } from '../bootstrap.ts'

describe('starting scene', () => {
  it('spawns exactly the village + a 6x6 apple orchard (37 entities)', async () => {
    const { world } = await bootstrapSim(1)
    // 1 village + 6*6 apple trees.
    expect(entityCount(world)).toBe(37)
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
    const trees = entities.filter((e) => e.width === 1 && e.height === 1)
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
})
