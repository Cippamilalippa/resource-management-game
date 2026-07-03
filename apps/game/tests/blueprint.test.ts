import { describe, it, expect } from 'vitest'
import { createGameWorld, type GameWorld } from '@factory/engine/core'
import { PrototypeRegistry } from '@factory/engine/data'
import { createModApi } from '@factory/engine/scripting'
import {
  createGameState,
  createGameSystems,
  enqueuePlaceBelt,
  enqueuePlaceBuilding,
  enqueuePlacePort,
  enqueuePlaceProducer,
  enqueuePlaceSplitter,
  type GameState,
} from '../src/gameLogic.ts'
import { InspectRegistry } from '../src/inspect.ts'
import {
  captureBlueprint,
  blueprintPlacements,
  blueprintGhostCells,
  serializeBlueprint,
  parseBlueprint,
  normalizeRect,
  type Blueprint,
} from '../src/blueprint.ts'

/** Drain the command queue (and tick the grid once) so just-enqueued placements are live. */
function flush(world: GameWorld, state: GameState): void {
  const api = createModApi('base', {
    registry: new PrototypeRegistry(),
    world,
    addSystem: () => {},
  })
  for (const system of createGameSystems(state, api)) system(world)
}

/** A tiny fixed blueprint used by the pure-transform tests. */
const FIXTURE: Blueprint = {
  w: 2,
  h: 2,
  entries: [
    { kind: 'belt', dx: 0, dy: 0, face: 1, color: 0x404040, moveEvery: 60 },
    { kind: 'port', dx: 0, dy: 0, port: 'output', dir: 3, color: 0x445500, spawnEvery: 20 },
    {
      kind: 'building',
      dx: 1,
      dy: 1,
      w: 1,
      h: 1,
      color: 0xb5651d,
      accepts: [{ color: 0x112233, cap: 50 }],
    },
  ],
}

describe('normalizeRect', () => {
  it('orders the corners regardless of drag direction', () => {
    expect(normalizeRect(5, 8, 2, 3)).toEqual({ x0: 2, y0: 3, x1: 5, y1: 8 })
    expect(normalizeRect(2, 3, 5, 8)).toEqual({ x0: 2, y0: 3, x1: 5, y1: 8 })
  })
})

describe('blueprintPlacements', () => {
  it('offsets every entry by the paste origin and keeps its config', () => {
    const out = blueprintPlacements(FIXTURE, 10, 20)
    const belt = out.find((p) => p.kind === 'belt')!
    // A belt becomes a length-1 run carrying its forced facing.
    expect(belt).toMatchObject({ ax: 10, ay: 20, bx: 10, by: 20, face: 1, moveEvery: 60 })
    const port = out.find((p) => p.kind === 'port')!
    expect(port).toMatchObject({ x: 10, y: 20, port: 'output', dir: 3, spawnEvery: 20 })
    const building = out.find((p) => p.kind === 'building')!
    expect(building).toMatchObject({ x: 11, y: 21, accepts: [{ color: 0x112233, cap: 50 }] })
  })
})

describe('blueprintGhostCells', () => {
  it('produces one footprint cell per entry, with port facing preserved', () => {
    const cells = blueprintGhostCells(FIXTURE, 0, 0)
    expect(cells).toContainEqual({ x: 0, y: 0, w: 1, h: 1, color: 0x404040 })
    expect(cells).toContainEqual({ x: 0, y: 0, w: 1, h: 1, color: 0x445500, dir: 3 })
    expect(cells).toContainEqual({ x: 1, y: 1, w: 1, h: 1, color: 0xb5651d })
  })
})

describe('serialize/parse blueprint', () => {
  it('round-trips through JSON', () => {
    const back = parseBlueprint(serializeBlueprint(FIXTURE))
    expect(back).toEqual(FIXTURE)
  })

  it('returns null for malformed text', () => {
    expect(parseBlueprint('not json')).toBeNull()
    expect(parseBlueprint('{"w":1}')).toBeNull() // missing h/entries
  })
})

describe('captureBlueprint', () => {
  it('captures belts, ports and buildings inside the rect, relative to its top-left', () => {
    const world = createGameWorld(1)
    const state = createGameState()
    const reg = new InspectRegistry()
    // A farm at (5,5) drained by an output on a belt to its east.
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
    enqueuePlaceBelt(world, { ax: 6, ay: 5, bx: 8, by: 5, color: 0x404040, moveEvery: 60 })
    enqueuePlacePort(world, { x: 6, y: 5, port: 'output', color: 0x445500, spawnEvery: 20 })
    flush(world, state)

    const bp = captureBlueprint(state, world, reg, normalizeRect(5, 5, 8, 5))
    expect(bp.w).toBe(4)
    expect(bp.h).toBe(1)
    // Three belt tiles (6,7,8 → dx 1,2,3), one output overlay, one crafter (the farm at dx 0).
    const belts = bp.entries.filter((e) => e.kind === 'belt')
    expect(belts.map((b) => b.dx).sort()).toEqual([1, 2, 3])
    const port = bp.entries.find((e) => e.kind === 'port')
    expect(port).toMatchObject({ kind: 'port', dx: 1, dy: 0, port: 'output', spawnEvery: 20 })
    const crafter = bp.entries.find((e) => e.kind === 'crafter')
    expect(crafter).toMatchObject({ kind: 'crafter', dx: 0, dy: 0, name: 'Farm' })
    // The farm's single output (colour 0xabcdef) is captured; no stockpile counts leak in.
    expect(crafter && crafter.kind === 'crafter' && crafter.outputs).toEqual([
      { color: 0xabcdef, amount: 1 },
    ])
  })

  it('captures a plain store and a splitter, and excludes objects outside the rect', () => {
    const world = createGameWorld(1)
    const state = createGameState()
    const reg = new InspectRegistry()
    enqueuePlaceBelt(world, { ax: 0, ay: 0, bx: 3, by: 0, color: 0x404040, moveEvery: 60 })
    enqueuePlaceSplitter(world, { x: 1, y: 0, color: 0x9b59b6 })
    enqueuePlaceBuilding(world, {
      x: 0,
      y: 1,
      w: 1,
      h: 1,
      color: 0xb5651d,
      accepts: [{ color: 0x112233, cap: 50 }],
    })
    // A belt well outside the capture rect — must not be captured.
    enqueuePlaceBelt(world, { ax: 20, ay: 20, bx: 22, by: 20, color: 0x404040, moveEvery: 60 })
    flush(world, state)

    const bp = captureBlueprint(state, world, reg, normalizeRect(0, 0, 3, 1))
    expect(bp.entries.some((e) => e.kind === 'splitter' && e.dx === 1 && e.dy === 0)).toBe(true)
    const store = bp.entries.find((e) => e.kind === 'building')
    expect(store).toMatchObject({
      kind: 'building',
      dx: 0,
      dy: 1,
      accepts: [{ color: 0x112233, cap: 50 }],
    })
    // Only the 4 in-rect belt tiles (x 0..3) are captured, none from the far belt at x≥20.
    expect(bp.entries.filter((e) => e.kind === 'belt').length).toBe(4)
  })

  it('round-trips: a captured region re-places to an equivalent capture at the paste origin', () => {
    const world = createGameWorld(1)
    const state = createGameState()
    const reg = new InspectRegistry()
    enqueuePlaceBelt(world, { ax: 2, ay: 2, bx: 4, by: 2, color: 0x404040, moveEvery: 60 })
    enqueuePlacePort(world, { x: 2, y: 2, port: 'output', color: 0x445500, spawnEvery: 20, dir: 1 })
    flush(world, state)
    const bp = captureBlueprint(state, world, reg, normalizeRect(2, 2, 4, 2))

    // Paste it 10 tiles over into a fresh world, then re-capture and compare (offset-normalized).
    const w2 = createGameWorld(1)
    const s2 = createGameState()
    const reg2 = new InspectRegistry()
    for (const p of blueprintPlacements(bp, 12, 2)) {
      if (p.kind === 'belt')
        enqueuePlaceBelt(w2, {
          ax: p.ax,
          ay: p.ay,
          bx: p.bx,
          by: p.by,
          color: p.color,
          moveEvery: p.moveEvery,
          face: p.face,
        })
      else if (p.kind === 'port')
        enqueuePlacePort(w2, {
          x: p.x,
          y: p.y,
          port: p.port,
          color: p.color,
          spawnEvery: p.spawnEvery,
          dir: p.dir,
        })
    }
    flush(w2, s2)
    const bp2 = captureBlueprint(s2, w2, reg2, normalizeRect(12, 2, 14, 2))
    // Same shape and the same relative entries (facing preserved through the length-1 paste).
    expect(bp2.w).toBe(bp.w)
    expect(
      bp2.entries.filter((e) => e.kind === 'belt').map((e) => e.kind === 'belt' && e.face),
    ).toEqual(bp.entries.filter((e) => e.kind === 'belt').map((e) => e.kind === 'belt' && e.face))
    expect(bp2.entries.some((e) => e.kind === 'port' && e.dir === 1)).toBe(true)
  })
})
