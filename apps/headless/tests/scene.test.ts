import { describe, it, expect } from 'vitest'
import { entityCount } from '@factory/engine/core'
import { serialize, hashSnapshot } from '@factory/engine/persistence'
import { TERRAIN_SPRITE, tileKey, terrainTypeOf } from '../gameLogic.ts'
import { bootstrapSim, type Sim } from '../bootstrap.ts'

/**
 * The starting scene is procedural: within the chosen scenario's bounded `worldSize` it grows organic
 * biome blobs (water + cosmetic ground) and scatters each resource deposit as several organic patches,
 * all from the world's seeded RNG — so each new game is varied yet fully reproducible for a given seed
 * + scenario. Determinism is the single most important guarantee in the codebase, so these assert
 * byte-reproducibility (and that seed + scenario both matter), the fixed anchors (village, orchard) the
 * layout keeps, and the procedural invariants: organic (non-square) patches, multiple patches per
 * deposit, and deposits never on impassable water.
 */

const WATER = terrainTypeOf('terrain.water')

/** Total stock currently held across every building stockpile slot (the starting kit lands here). */
function totalStock(sim: Sim): number {
  const store = sim.state.buildings
  let sum = 0
  for (let i = 0; i < store.slotCount.length; i++) sum += store.slotCount[i]!
  return sum
}

/** Terrain render entities (a flat fill) from a serialized world, as { x, y, color } tiles. */
function terrainTiles(sim: Sim): { x: number; y: number; color: number }[] {
  const { entities } = serialize(sim.world)
  return entities
    .filter((e) => e.sprite === TERRAIN_SPRITE)
    .map((e) => ({ x: e.x, y: e.y, color: e.color }))
}

/**
 * Split a set of tiles into 4-connected components (flood fill). Returns each component's tile count
 * and bounding-box area — an organic blob has bbox area strictly greater than its tile count (it does
 * not fill its bounding rectangle), whereas the old square patch had bbox area === tile count.
 */
function components(tiles: { x: number; y: number }[]): { size: number; bboxArea: number }[] {
  const keyed = new Map<number, { x: number; y: number }>()
  for (const t of tiles) keyed.set(tileKey(t.x, t.y), t)
  const seen = new Set<number>()
  const out: { size: number; bboxArea: number }[] = []
  for (const [startKey, start] of keyed) {
    if (seen.has(startKey)) continue
    let size = 0
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    const stack = [start]
    seen.add(startKey)
    while (stack.length > 0) {
      const { x, y } = stack.pop()!
      size++
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
      minY = Math.min(minY, y)
      maxY = Math.max(maxY, y)
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nk = tileKey(x + dx, y + dy)
        if (keyed.has(nk) && !seen.has(nk)) {
          seen.add(nk)
          stack.push(keyed.get(nk)!)
        }
      }
    }
    out.push({ size, bboxArea: (maxX - minX + 1) * (maxY - minY + 1) })
  }
  return out
}

describe('procedural starting scene', () => {
  it('is deterministic: same seed + scenario → identical snapshot hash, before and after ticks', async () => {
    const a = await bootstrapSim(1234, { scenario: 'scenario.abundant' })
    const b = await bootstrapSim(1234, { scenario: 'scenario.abundant' })
    expect(hashSnapshot(a.serialize())).toBe(hashSnapshot(b.serialize()))
    a.scheduler.runTicks(a.world, 300)
    b.scheduler.runTicks(b.world, 300)
    expect(hashSnapshot(a.serialize())).toBe(hashSnapshot(b.serialize()))
  })

  it('varies the layout with the seed', async () => {
    const a = await bootstrapSim(1, { scenario: 'scenario.abundant' })
    const b = await bootstrapSim(2, { scenario: 'scenario.abundant' })
    expect(hashSnapshot(a.serialize())).not.toBe(hashSnapshot(b.serialize()))
  })

  it('differs between scenarios at the same seed (world size / biomes / patches / kit)', async () => {
    const abundant = await bootstrapSim(42, { scenario: 'scenario.abundant' })
    const sparse = await bootstrapSim(42, { scenario: 'scenario.sparse' })
    expect(hashSnapshot(abundant.serialize())).not.toBe(hashSnapshot(sparse.serialize()))
  })

  it('records every painted tile in the terrain grid, mixing biomes and deposits', async () => {
    const sim = await bootstrapSim(7, { scenario: 'scenario.abundant' })
    const tiles = terrainTiles(sim)
    // Every painted terrain tile is mirrored into the grid so placement can read it.
    expect(sim.state.terrain.size).toBe(tiles.length)
    expect(sim.state.terrain.size).toBeGreaterThan(0)
    // 3 settlements (spaceport + mining camp + research colony) + terrain tiles + a 6x6 orchard.
    expect(entityCount(sim.world)).toBe(3 + sim.state.terrain.size + 36)
    // The grid holds both deposit tiles (finite richness recorded) and non-deposit biome tiles.
    const depositTiles = sim.state.deposits.remaining.size
    expect(depositTiles).toBeGreaterThan(0)
    expect(sim.state.terrain.size).toBeGreaterThan(depositTiles) // biomes add non-deposit ground.
  })

  it('grows organic (non-square) patches, not filled rectangles', async () => {
    const sim = await bootstrapSim(7, { scenario: 'scenario.abundant' })
    const tiles = terrainTiles(sim)
    // Group same-colour tiles into blobs; at least one non-trivial blob must NOT fill its bbox.
    const byColor = new Map<number, { x: number; y: number }[]>()
    for (const t of tiles) (byColor.get(t.color) ?? byColor.set(t.color, []).get(t.color)!).push(t)
    let sawOrganic = false
    for (const group of byColor.values()) {
      for (const c of components(group)) {
        if (c.size >= 6 && c.bboxArea > c.size) sawOrganic = true
      }
    }
    expect(sawOrganic).toBe(true)
  })

  it('scatters multiple patches per deposit type (frequency)', async () => {
    const sim = await bootstrapSim(7, { scenario: 'scenario.abundant' })
    // Deposit terrain colours only (finite richness recorded under them).
    const depositKeys = new Set(sim.state.deposits.remaining.keys())
    const depositTiles = terrainTiles(sim).filter((t) => depositKeys.has(tileKey(t.x, t.y)))
    const byColor = new Map<number, { x: number; y: number }[]>()
    for (const t of depositTiles)
      (byColor.get(t.color) ?? byColor.set(t.color, []).get(t.color)!).push(t)
    // Abundant rolls 2–3 patches per type; across six types the total component count exceeds the
    // six deposit types, proving at least some type produced more than one patch.
    let totalComponents = 0
    for (const group of byColor.values()) totalComponents += components(group).length
    expect(totalComponents).toBeGreaterThan(6)
  })

  it('never lays a deposit on impassable water; water is registered as build-blocking', async () => {
    const sim = await bootstrapSim(7, { scenario: 'scenario.abundant' })
    expect(sim.state.blockingTerrain.has(WATER)).toBe(true)
    let waterTiles = 0
    for (const [key, type] of sim.state.terrain) {
      if (type === WATER) {
        waterTiles++
        // No deposit richness is ever recorded under a water tile.
        expect(sim.state.deposits.remaining.has(key)).toBe(false)
      }
    }
    // The abundant scenario authors a water biome, so some water was painted.
    expect(waterTiles).toBeGreaterThan(0)
  })

  it('grants the abundant scenario its starting-kit stock (sparse gets none)', async () => {
    const abundant = await bootstrapSim(7, { scenario: 'scenario.abundant' })
    const sparse = await bootstrapSim(7, { scenario: 'scenario.sparse' })
    expect(totalStock(abundant)).toBeGreaterThan(0)
    expect(totalStock(sparse)).toBe(0)
  })

  it('rolls a finite richness for every deposit tile, within each scenario band', async () => {
    // Abundant: generous band (1200–2400) rolled under each deposit tile (a subset of terrain).
    const abundant = await bootstrapSim(7, { scenario: 'scenario.abundant' })
    expect(abundant.state.deposits.remaining.size).toBeGreaterThan(0)
    for (const units of abundant.state.deposits.remaining.values()) {
      expect(units).toBeGreaterThanOrEqual(1200)
      expect(units).toBeLessThanOrEqual(2400)
    }
    // Sparse: tighter band (300–700) — its deposits carry less.
    const sparse = await bootstrapSim(7, { scenario: 'scenario.sparse' })
    for (const units of sparse.state.deposits.remaining.values()) {
      expect(units).toBeGreaterThanOrEqual(300)
      expect(units).toBeLessThanOrEqual(700)
    }
  })

  it('keeps the fixed anchors: the 2x2 spaceport on the origin and a 6x6 orchard at (50,50)', async () => {
    const { world } = await bootstrapSim(1, { scenario: 'scenario.abundant' })
    const { entities } = serialize(world)
    // Three 2x2 settlements, the spaceport's top-left at (-1, -1).
    const villages = entities.filter((e) => e.width === 2 && e.height === 2)
    expect(villages).toHaveLength(3)
    expect(villages.some((v) => v.x === -1 && v.y === -1)).toBe(true)
    // 6x6 orchard: 1x1 default-glyph (sprite 0) trees in [50,55]².
    const trees = entities.filter((e) => e.width === 1 && e.height === 1 && e.sprite === 0)
    expect(trees).toHaveLength(36)
    for (const t of trees) {
      expect(t.x).toBeGreaterThanOrEqual(50)
      expect(t.x).toBeLessThanOrEqual(55)
      expect(t.y).toBeGreaterThanOrEqual(50)
      expect(t.y).toBeLessThanOrEqual(55)
    }
  })

  it('keeps the extra settlements clear of terrain, the orchard, and each other', async () => {
    // Several seeds, so a lucky layout can't mask an overlap bug in the reserved-rect logic.
    for (const seed of [1, 7, 42]) {
      const sim = await bootstrapSim(seed, { scenario: 'scenario.abundant' })
      const v = sim.state.villages
      expect(v.count).toBe(3)
      for (let i = 0; i < v.count; i++) {
        // No settlement footprint tile sits on any painted terrain tile (biome or deposit).
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const x = v.vx[i]! + dx
            const y = v.vy[i]! + dy
            expect(sim.state.terrain.has(tileKey(x, y))).toBe(false)
            // ...and not inside the orchard square either.
            expect(x >= 50 && x <= 55 && y >= 50 && y <= 55).toBe(false)
          }
        }
        // Footprints don't overlap each other.
        for (let j = i + 1; j < v.count; j++) {
          const apart = Math.abs(v.vx[i]! - v.vx[j]!) >= 2 || Math.abs(v.vy[i]! - v.vy[j]!) >= 2
          expect(apart).toBe(true)
        }
      }
    }
  })
})
