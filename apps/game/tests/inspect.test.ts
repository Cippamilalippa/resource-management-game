import { describe, it, expect } from 'vitest'
import { createGameWorld, spawnEntity, type GameWorld } from '@factory/engine/core'
import { PrototypeRegistry } from '@factory/engine/data'
import { createModApi } from '@factory/engine/scripting'
import {
  createGameState,
  createGameSystems,
  enqueuePlaceBelt,
  enqueuePlaceBuilding,
  enqueuePlacePort,
  enqueuePlaceProducer,
  tileKey,
  TERRAIN_SPRITE,
  type GameState,
} from '../src/gameLogic.ts'
import { InspectRegistry, resolveInspect } from '../src/inspect.ts'

/**
 * Drain the command queue (and tick the grid once) so a just-enqueued placement is live.
 * The base systems reach the engine through the `ModApi`, so build a minimal host-bound api
 * over this world (the registry/addSystem sink go unused by the two systems here).
 */
function flush(world: GameWorld, state: GameState): void {
  const api = createModApi('base', {
    registry: new PrototypeRegistry(),
    world,
    addSystem: () => {},
  })
  for (const system of createGameSystems(state, api)) system(world)
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
      resolveInspect(
        world,
        state.grid,
        state.buildings,
        state.villages,
        state.deposits,
        new InspectRegistry(),
        99,
        99,
      ),
    ).toBeNull()
  })

  it('describes a plain belt tile with name, facing and speed', () => {
    const world = createGameWorld(1)
    const state = createGameState()
    const reg = new InspectRegistry()
    enqueuePlaceBelt(world, { ax: 0, ay: 0, bx: 4, by: 0, color: 0x404040, moveEvery: 60 })
    flush(world, state)
    reg.record(0, 0, { name: 'Conveyor Belt Mk1', type: 'belt' })

    const info = resolveInspect(
      world,
      state.grid,
      state.buildings,
      state.villages,
      state.deposits,
      reg,
      0,
      0,
    )
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
      resolveInspect(
        world,
        state.grid,
        state.buildings,
        state.villages,
        state.deposits,
        new InspectRegistry(),
        1,
        0,
      )?.title,
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

    const info = resolveInspect(
      world,
      state.grid,
      state.buildings,
      state.villages,
      state.deposits,
      reg,
      6,
      5,
    )
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
    // The input's arrow must point *at* the building it feeds: the Village is to the West, so
    // the port faces West (dir 3).
    enqueuePlacePort(world, { x: 6, y: 5, port: 'input', color: 0xdd4444, dir: 3 })
    flush(world, state)

    const info = resolveInspect(
      world,
      state.grid,
      state.buildings,
      state.villages,
      state.deposits,
      reg,
      6,
      5,
    )
    expect(info?.subtitle).toBe('Input port · facing West')
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

    const info = resolveInspect(
      world,
      state.grid,
      state.buildings,
      state.villages,
      state.deposits,
      reg,
      5,
      5,
    )
    expect(info?.subtitle).toBe('Producer')
    expect(info?.stats).toContainEqual({ kind: 'text', label: 'Craft rate', value: '2 /s' })
    // A drain-only recipe output shows under the "Produces" section as an icon + current/total bar.
    expect(info?.stats).toContainEqual({ kind: 'heading', label: 'Produces' })
    // The recipe progress bar (added ahead of the stock bars) is also a 'bar' row but carries no
    // resource colour, so the stock bar is the first *coloured* bar.
    const stock = info?.stats.find((s) => s.kind === 'bar' && s.color !== undefined)
    // The output bar carries a positive per-second throughput (1 unit every 30 ticks → "2/s").
    expect(stock).toMatchObject({ kind: 'bar', max: 100, color: 0x112233, rate: '2/s' })
  })

  it('shows a recipe progress bar for a crafter, and an optional utilization readout', () => {
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
      produceEvery: 10,
      storageCap: 100,
    })
    reg.record(5, 5, { name: 'Farm', type: 'producer' })
    flush(world, state) // tick 1: places the crafter, craft timer starts at 0
    flush(world, state) // tick 2
    flush(world, state) // tick 3: craft timer accrues to 3 (below the 10-tick cadence)

    const info = resolveInspect(
      world,
      state.grid,
      state.buildings,
      state.villages,
      state.deposits,
      reg,
      5,
      5,
    )
    expect(info?.stats).toContainEqual({ kind: 'bar', label: 'Progress', value: 3, max: 10 })
    // No utilization callback passed: the readout is omitted rather than shown as "no data".
    expect(info?.stats.find((s) => s.label === 'Utilization (60s)')).toBeUndefined()

    // With a callback, the fraction is surfaced as a rounded percentage.
    const withUtilization = resolveInspect(
      world,
      state.grid,
      state.buildings,
      state.villages,
      state.deposits,
      reg,
      5,
      5,
      () => 0.5,
    )
    expect(withUtilization?.stats).toContainEqual({
      kind: 'text',
      label: 'Utilization (60s)',
      value: '50%',
    })

    // A callback that has no data yet (returns undefined) also omits the row.
    const noData = resolveInspect(
      world,
      state.grid,
      state.buildings,
      state.villages,
      state.deposits,
      reg,
      5,
      5,
      () => undefined,
    )
    expect(noData?.stats.find((s) => s.label === 'Utilization (60s)')).toBeUndefined()
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

    // Resolving any footprint tile finds the building and its stock bar. A dual-role store slot
    // (fillable + drainable) is held/consumed, so it appears under the "Consumes" section.
    const info = resolveInspect(
      world,
      state.grid,
      state.buildings,
      state.villages,
      state.deposits,
      reg,
      6,
      6,
    )
    expect(info?.title).toBe('Village')
    expect(info?.stats).toContainEqual({ kind: 'heading', label: 'Consumes' })
    const stock = info?.stats.find((s) => s.kind === 'bar')
    expect(stock).toMatchObject({ kind: 'bar', max: 50, color: 0x112233 })
  })

  it('shows remaining richness on a finite deposit tile, and "Exhausted" at zero', () => {
    const world = createGameWorld(1)
    const state = createGameState()
    const reg = new InspectRegistry()
    // Paint a finite deposit tile with a matching terrain entity, then set its remaining richness.
    const key = tileKey(8, 8)
    const eid = spawnEntity(world, {
      pos: { x: 8, y: 8 },
      sprite: TERRAIN_SPRITE,
      color: 0xb08d57,
      width: 1,
      height: 1,
    })
    state.deposits.remaining.set(key, 1240)
    state.deposits.eid.set(key, eid)
    reg.record(8, 8, { name: 'Bauxite Deposit', type: 'terrain' })

    const info = resolveInspect(
      world,
      state.grid,
      state.buildings,
      state.villages,
      state.deposits,
      reg,
      8,
      8,
    )
    expect(info?.title).toBe('Bauxite Deposit')
    expect(info?.stats).toContainEqual({ kind: 'text', label: 'Deposit', value: '1,240 left' })

    // Drained to zero: the row reads "Exhausted".
    state.deposits.remaining.set(key, 0)
    const spent = resolveInspect(
      world,
      state.grid,
      state.buildings,
      state.villages,
      state.deposits,
      reg,
      8,
      8,
    )
    expect(spent?.stats).toContainEqual({ kind: 'text', label: 'Deposit', value: 'Exhausted' })
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
      const info = resolveInspect(
        world,
        state.grid,
        state.buildings,
        state.villages,
        state.deposits,
        reg,
        x,
        y,
      )
      expect(info?.title).toBe('Village')
      expect(info?.subtitle).toBe('Building')
      expect(info?.footprint).toEqual({ x: -1, y: -1, w: 2, h: 2 })
    }
    expect(
      info_size(
        resolveInspect(
          world,
          state.grid,
          state.buildings,
          state.villages,
          state.deposits,
          reg,
          0,
          0,
        ),
      ),
    ).toBe('2×2')
  })
})

/** Pull the "Size" stat value out of a resolved building (test helper). */
function info_size(info: ReturnType<typeof resolveInspect>): string | undefined {
  const stat = info?.stats.find((s) => s.label === 'Size')
  return stat && stat.kind === 'text' ? stat.value : undefined
}
