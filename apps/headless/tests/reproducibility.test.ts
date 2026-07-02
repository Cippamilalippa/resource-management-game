import { describe, it, expect } from 'vitest'
import { entityCount } from '@factory/engine/core'
import { hashState } from '@factory/engine/persistence'
import { bootstrapSim } from '../bootstrap.ts'
import { buildableSet, type BuildableProto } from '../gameLogic.ts'

describe('headless reproducibility', () => {
  it('discovers and loads the base game (mods/base) through the mod loader path', async () => {
    const { load, registry } = await bootstrapSim(1)
    expect(load.order.map((m) => m.id)).toContain('base')
    expect(load.prototypeCount).toBeGreaterThan(0)
    // The base game ships specialized crafters (drill/refinery/smelter…) and a spaceport.
    expect(registry.listByType('crafter').length).toBeGreaterThan(0)
    expect(registry.listByType('village').length).toBeGreaterThan(0)
  })

  it('gates progression: only bootstrap content is buildable at the root; the rocket needs the whole tree', async () => {
    const { registry } = await bootstrapSim(1)
    const prototypes = registry.list() as readonly BuildableProto[]
    const techs = registry.listByType('technology') as ReadonlyArray<{
      id: string
      prerequisites?: unknown
    }>
    // Root (no-prerequisite) techs are seeded researched from the start.
    const roots = new Set(
      techs
        .filter((t) => !Array.isArray(t.prerequisites) || t.prerequisites.length === 0)
        .map((t) => t.id),
    )
    const atStart = buildableSet(prototypes, roots)
    // The bootstrap kit is available; the deep goods are locked behind research.
    expect(atStart.has('building.mining_drill')).toBe(true)
    expect(atStart.has('building.science_press')).toBe(true)
    expect(atStart.has('recipe.science_materials')).toBe(true)
    expect(atStart.has('recipe.rocket')).toBe(false)
    expect(atStart.has('building.assembly_hall')).toBe(false)

    // With every tech researched, the apex good and its buildings unlock.
    const all = new Set(techs.map((t) => t.id))
    const fully = buildableSet(prototypes, all)
    expect(fully.has('recipe.rocket')).toBe(true)
    expect(fully.has('building.assembly_hall')).toBe(true)
  })

  it('same seed + tick count -> identical final state hash', async () => {
    const a = await bootstrapSim(7)
    const b = await bootstrapSim(7)
    a.scheduler.runTicks(a.world, 500)
    b.scheduler.runTicks(b.world, 500)
    expect(entityCount(a.world)).toBe(entityCount(b.world))
    expect(hashState(a.world)).toBe(hashState(b.world))
  })

  it('different seeds produce different state', async () => {
    const a = await bootstrapSim(1)
    const b = await bootstrapSim(2)
    a.scheduler.runTicks(a.world, 500)
    b.scheduler.runTicks(b.world, 500)
    expect(hashState(a.world)).not.toBe(hashState(b.world))
  })
})
