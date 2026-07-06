import { describe, it, expect } from 'vitest'
import { entityCount } from '@factory/engine/core'
import { serialize, hashSnapshot } from '@factory/engine/persistence'
import { TERRAIN_SPRITE, tileKey } from '../gameLogic.ts'
import { bootstrapSim, type Sim } from '../bootstrap.ts'

/**
 * The starting scene is procedural: it scatters the chosen scenario's resource deposits using the
 * world's seeded RNG within the scenario's size/spread bands, so each new game is varied yet fully
 * reproducible for a given seed + scenario. Determinism is the single most important guarantee in
 * the codebase, so these assert byte-reproducibility (and that seed + scenario both matter), along
 * with the fixed anchors (village, orchard) the layout keeps.
 */

/** Six deposits, each a 4–5-tile square in the abundant scenario. */
const MIN_TERRAIN = 6 * 4 * 4
const MAX_TERRAIN = 6 * 5 * 5

/** Total stock currently held across every building stockpile slot (the starting kit lands here). */
function totalStock(sim: Sim): number {
  const store = sim.state.buildings
  let sum = 0
  for (let i = 0; i < store.slotCount.length; i++) sum += store.slotCount[i]!
  return sum
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

  it('differs between scenarios at the same seed (patch sizes / spread / kit)', async () => {
    const abundant = await bootstrapSim(42, { scenario: 'scenario.abundant' })
    const sparse = await bootstrapSim(42, { scenario: 'scenario.sparse' })
    expect(hashSnapshot(abundant.serialize())).not.toBe(hashSnapshot(sparse.serialize()))
  })

  it('lays out every scenario deposit as a terrain patch, recorded in the terrain grid', async () => {
    const sim = await bootstrapSim(7, { scenario: 'scenario.abundant' })
    const { entities } = serialize(sim.world)
    const terrain = entities.filter((e) => e.sprite === TERRAIN_SPRITE)
    // Every painted terrain tile is mirrored into the grid so producer placement can read it.
    expect(sim.state.terrain.size).toBe(terrain.length)
    expect(sim.state.terrain.size).toBeGreaterThanOrEqual(MIN_TERRAIN)
    expect(sim.state.terrain.size).toBeLessThanOrEqual(MAX_TERRAIN)
    // 3 settlements (spaceport + mining camp + research colony) + terrain tiles + a 6x6 orchard.
    expect(entityCount(sim.world)).toBe(3 + sim.state.terrain.size + 36)
  })

  it('grants the abundant scenario its starting-kit stock (sparse gets none)', async () => {
    const abundant = await bootstrapSim(7, { scenario: 'scenario.abundant' })
    const sparse = await bootstrapSim(7, { scenario: 'scenario.sparse' })
    expect(totalStock(abundant)).toBeGreaterThan(0)
    expect(totalStock(sparse)).toBe(0)
  })

  it('rolls a finite richness for every deposit tile, within each scenario band', async () => {
    // Abundant: generous band (1200–2400), one richness entry per painted deposit tile.
    const abundant = await bootstrapSim(7, { scenario: 'scenario.abundant' })
    expect(abundant.state.deposits.remaining.size).toBe(abundant.state.terrain.size)
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

  it('keeps the extra settlements clear of deposits, the orchard, and each other', async () => {
    // Several seeds, so a lucky layout can't mask an overlap bug in the reserved-rect logic.
    for (const seed of [1, 7, 42]) {
      const sim = await bootstrapSim(seed, { scenario: 'scenario.abundant' })
      const v = sim.state.villages
      expect(v.count).toBe(3)
      for (let i = 0; i < v.count; i++) {
        // No settlement footprint tile sits on a deposit terrain tile.
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
