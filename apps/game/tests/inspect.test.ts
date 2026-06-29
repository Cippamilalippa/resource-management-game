import { describe, it, expect } from 'vitest'
import { createGameWorld, spawnEntity, type GameWorld } from '@factory/engine/core'
import {
  createGameState,
  createGameSystems,
  enqueuePlaceBelt,
  enqueuePlaceBuilding,
  enqueuePlacePort,
  enqueuePlaceProducer,
  type GameState,
} from '../src/gameLogic.ts'
import { InspectRegistry, resolveInspect } from '../src/inspect.ts'

/** Drain the command queue (and tick the grid once) so a just-enqueued placement is live. */
function flush(world: GameWorld, state: GameState): void {
  for (const system of createGameSystems(state)) system(world)
}

describe('InspectRegistry', () => {
  it('records and reads a name back at a tile, and misses elsewhere', () => {
    const reg = new InspectRegistry()
    reg.record(3, -7, { name: 'Village', type: 'building' })
    expect(reg.get(3, -7)).toEqual({ name: 'Village', type: 'building' })
    expect(reg.get(3, -6)).toBeUndefined()
  })
})

describe('resolveInspect', () => {
  it('returns null over empty ground', () => {
    const world = createGameWorld(1)
    const state = createGameState()
    expect(
      resolveInspect(world, state.grid, state.buildings, new InspectRegistry(), 99, 99),
    ).toBeNull()
  })

  it('describes a plain belt tile with name, facing and speed', () => {
    const world = createGameWorld(1)
    const state = createGameState()
    const reg = new InspectRegistry()
    enqueuePlaceBelt(world, { ax: 0, ay: 0, bx: 4, by: 0, color: 0x404040, moveEvery: 60 })
    flush(world, state)
    reg.record(0, 0, { name: 'Conveyor Belt Mk1', type: 'belt' })

    const info = resolveInspect(world, state.grid, state.buildings, reg, 0, 0)
    expect(info?.title).toBe('Conveyor Belt Mk1')
    expect(info?.subtitle).toBe('Conveyor belt · facing East')
    expect(info?.footprint).toEqual({ x: 0, y: 0, w: 1, h: 1 })
    // moveEvery 60 ticks/tile at 60 tps = 1 tile/s.
    expect(info?.stats).toContainEqual({ kind: 'text', label: 'Speed', value: '1 tiles/s' })
    expect(info?.stats).toContainEqual({ kind: 'text', label: 'Carrying', value: '—' })
  })

  it('falls back to a generic name when the tile is unnamed', () => {
    const world = createGameWorld(1)
    const state = createGameState()
    enqueuePlaceBelt(world, { ax: 0, ay: 0, bx: 2, by: 0, color: 0x404040, moveEvery: 60 })
    flush(world, state)
    expect(
      resolveInspect(world, state.grid, state.buildings, new InspectRegistry(), 1, 0)?.title,
    ).toBe('Conveyor belt')
  })

  it('describes an output port by the rate and building it drains', () => {
    const world = createGameWorld(1)
    const state = createGameState()
    const reg = new InspectRegistry()
    // A farm at (5,5), a belt beside it, and an output on the belt draining the farm.
    enqueuePlaceProducer(world, {
      x: 5,
      y: 5,
      w: 1,
      h: 1,
      color: 0x778800,
      itemColor: 0xabcdef,
      produceEvery: 20,
      storageCap: 100,
    })
    reg.record(5, 5, { name: 'Farm', type: 'producer' })
    enqueuePlaceBelt(world, { ax: 6, ay: 5, bx: 9, by: 5, color: 0x404040, moveEvery: 60 })
    enqueuePlacePort(world, { x: 6, y: 5, port: 'output', color: 0x445500, spawnEvery: 20 })
    flush(world, state)

    const info = resolveInspect(world, state.grid, state.buildings, reg, 6, 5)
    expect(info?.subtitle).toBe('Output port · facing East')
    // 20 ticks/item at 60 tps = 3 items/s.
    expect(info?.stats).toContainEqual({ kind: 'text', label: 'Output rate', value: '3 /s' })
    expect(info?.stats).toContainEqual({ kind: 'text', label: 'Drains', value: 'Farm' })
  })

  it('describes an input port by the building it feeds', () => {
    const world = createGameWorld(1)
    const state = createGameState()
    const reg = new InspectRegistry()
    enqueuePlaceBuilding(world, {
      x: 5,
      y: 5,
      w: 1,
      h: 1,
      color: 0xb5651d,
      accepts: [{ color: 0x112233, cap: 50 }],
    })
    reg.record(5, 5, { name: 'Village', type: 'building' })
    enqueuePlaceBelt(world, { ax: 6, ay: 5, bx: 9, by: 5, color: 0x404040, moveEvery: 60 })
    enqueuePlacePort(world, { x: 6, y: 5, port: 'input', color: 0xdd4444 })
    flush(world, state)

    const info = resolveInspect(world, state.grid, state.buildings, reg, 6, 5)
    expect(info?.subtitle).toBe('Input port · facing East')
    expect(info?.stats).toContainEqual({ kind: 'text', label: 'Feeds', value: 'Village' })
  })

  it('describes a producer building with a production rate and a stock bar', () => {
    const world = createGameWorld(1)
    const state = createGameState()
    const reg = new InspectRegistry()
    enqueuePlaceProducer(world, {
      x: 5,
      y: 5,
      w: 1,
      h: 1,
      color: 0x778800,
      itemColor: 0x112233,
      produceEvery: 30,
      storageCap: 100,
    })
    reg.record(5, 5, { name: 'Farm', type: 'producer' })
    flush(world, state)

    const info = resolveInspect(world, state.grid, state.buildings, reg, 5, 5)
    expect(info?.subtitle).toBe('Producer')
    expect(info?.stats).toContainEqual({ kind: 'text', label: 'Produces', value: '2 /s' })
    const stock = info?.stats.find((s) => s.label === 'Stock')
    expect(stock).toMatchObject({ kind: 'bar', max: 100, color: 0x112233 })
  })

  it('shows a stock bar per resource on a resource-holding building', () => {
    const world = createGameWorld(1)
    const state = createGameState()
    const reg = new InspectRegistry()
    enqueuePlaceBuilding(world, {
      x: 5,
      y: 5,
      w: 2,
      h: 2,
      color: 0xb5651d,
      accepts: [{ color: 0x112233, cap: 50 }],
    })
    reg.record(5, 5, { name: 'Village', type: 'building' })
    flush(world, state)

    // Resolving any footprint tile finds the building and its stock bar.
    const info = resolveInspect(world, state.grid, state.buildings, reg, 6, 6)
    expect(info?.title).toBe('Village')
    const stock = info?.stats.find((s) => s.label === 'Stock')
    expect(stock).toMatchObject({ kind: 'bar', max: 50, color: 0x112233 })
  })

  it('describes a multi-tile building across its whole footprint', () => {
    const world = createGameWorld(1)
    const state = createGameState()
    const reg = new InspectRegistry()
    spawnEntity(world, { pos: { x: -1, y: -1 }, color: 0xb5651d, width: 2, height: 2 })
    reg.record(-1, -1, { name: 'Village', type: 'building' })

    // Every tile of the 2x2 footprint resolves to the same building.
    for (const [x, y] of [
      [-1, -1],
      [0, -1],
      [-1, 0],
      [0, 0],
    ] as const) {
      const info = resolveInspect(world, state.grid, state.buildings, reg, x, y)
      expect(info?.title).toBe('Village')
      expect(info?.subtitle).toBe('Building')
      expect(info?.footprint).toEqual({ x: -1, y: -1, w: 2, h: 2 })
    }
    expect(info_size(resolveInspect(world, state.grid, state.buildings, reg, 0, 0))).toBe('2×2')
  })
})

/** Pull the "Size" stat value out of a resolved building (test helper). */
function info_size(info: ReturnType<typeof resolveInspect>): string | undefined {
  const stat = info?.stats.find((s) => s.label === 'Size')
  return stat && stat.kind === 'text' ? stat.value : undefined
}
