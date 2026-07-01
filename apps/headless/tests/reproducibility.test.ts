import { describe, it, expect } from 'vitest'
import { entityCount } from '@factory/engine/core'
import { hashState } from '@factory/engine/persistence'
import { bootstrapSim } from '../bootstrap.ts'

describe('headless reproducibility', () => {
  it('discovers and loads the base game (mods/base) through the mod loader path', async () => {
    const { load, registry } = await bootstrapSim(1)
    expect(load.order.map((m) => m.id)).toContain('base')
    expect(load.prototypeCount).toBeGreaterThan(0)
    // The base game ships crafters (farm/mine/furnace…) and a village.
    expect(registry.listByType('crafter').length).toBeGreaterThan(0)
    expect(registry.listByType('village').length).toBeGreaterThan(0)
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
