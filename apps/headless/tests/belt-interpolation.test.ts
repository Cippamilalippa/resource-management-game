import { describe, it, expect } from 'vitest'
import { lerp } from '@factory/shared'
import { hashState } from '@factory/engine/persistence'
import { bootstrapSim, type Sim } from '../bootstrap.ts'
import {
  beltMoveAlpha,
  enqueuePlaceBelt,
  enqueuePlacePort,
  enqueuePlaceProducer,
} from '../gameLogic.ts'

/**
 * Belt items step a whole tile once every `moveEvery` ticks. The renderer must glide them
 * across that tile over the whole move-cycle — interpolating with {@link beltMoveAlpha} and
 * the source tile the belt records in `Position.prev*` — rather than snapping a full tile on
 * the single move tick (which looked like teleporting). These tests drive the same
 * render-interpolation maths the game's frame loop uses, with no GPU/DOM needed.
 */

/**
 * Lay a 9-tile horizontal belt (from x=2, clear of the origin village) with a producer-fed
 * output at the head; items ride it to the right. The producer just west of the output keeps
 * it supplied so items keep entering.
 */
async function bootBelt(moveEvery: number, tickRate = 60): Promise<Sim> {
  const sim = await bootstrapSim(1, { tickRate })
  enqueuePlaceBelt(sim.world, { ax: 2, ay: 0, bx: 10, by: 0, color: 0x404040, moveEvery })
  enqueuePlaceProducer(sim.world, {
    x: 1,
    y: 0,
    w: 1,
    h: 1,
    color: 0x223344,
    itemColor: 0xffaa00,
    produceEvery: 1,
    storageCap: 1_000_000,
  })
  enqueuePlacePort(sim.world, { x: 2, y: 0, port: 'output', color: 0x44dd44, spawnEvery: 20 })
  sim.scheduler.runTicks(sim.world, 1) // drain the queued placements so the grid is live
  return sim
}

describe('beltMoveAlpha', () => {
  it('reports the fraction of the move-cycle elapsed', async () => {
    const sim = await bootBelt(60)
    const g = sim.state.grid
    g.moveTimer = 0
    expect(beltMoveAlpha(sim.state)).toBe(0)
    g.moveTimer = 30
    expect(beltMoveAlpha(sim.state)).toBeCloseTo(0.5, 6)
    g.moveTimer = 59
    expect(beltMoveAlpha(sim.state, 0.5)).toBeCloseTo(59.5 / 60, 6)
    // Always < 1 so the renderer never overshoots the destination tile.
    expect(beltMoveAlpha(sim.state, 0.999)).toBeLessThan(1)
  })

  it('falls back to the sub-tick alpha for a one-tile-per-tick belt', async () => {
    const sim = await bootBelt(1)
    expect(beltMoveAlpha(sim.state, 0.42)).toBe(0.42)
  })
})

describe('belt render interpolation', () => {
  it('records the source tile in prev* when an item steps', async () => {
    const sim = await bootBelt(2) // move every other tick so a step is easy to land on
    const { Position } = sim.world.components
    const g = sim.state.grid
    // Advance until an item has moved at least once (its tile differs from its prev tile).
    let moved = -1
    for (let i = 0; i < 50 && moved === -1; i++) {
      sim.scheduler.runTicks(sim.world, 1)
      for (let t = 0; t < g.count; t++) {
        const eid = g.slot[t]!
        if (eid !== -1 && Position.x[eid]! !== Position.prevX[eid]!) {
          moved = eid
          break
        }
      }
    }
    expect(moved).not.toBe(-1)
    // prev* is exactly one tile behind the current tile (the tile the item came from).
    const dx = Math.abs(Position.x[moved]! - Position.prevX[moved]!)
    const dy = Math.abs(Position.y[moved]! - Position.prevY[moved]!)
    expect(dx + dy).toBe(1)
  })

  it('glides one tile at a time — never teleports — at the real game config (60/60)', async () => {
    const sim = await bootBelt(60, 60)
    const { Position } = sim.world.components
    const dtMs = 1000 / 60 // render a 60fps frame

    let tracked = -1
    let prevRender = NaN
    let maxStep = 0
    let sampled = 0
    for (let f = 0; f < 1000 && sampled < 200; f++) {
      const sub = sim.scheduler.advance(sim.world, dtMs)
      const g = sim.state.grid
      if (tracked === -1) {
        for (let t = 0; t < g.count; t++)
          if (g.slot[t]! !== -1) {
            tracked = g.slot[t]!
            break
          }
      }
      if (tracked === -1) continue
      let alive = false
      for (let t = 0; t < g.count; t++)
        if (g.slot[t]! === tracked) {
          alive = true
          break
        }
      if (!alive) break

      const a = beltMoveAlpha(sim.state, sub)
      const rx = lerp(Position.prevX[tracked]!, Position.x[tracked]!, a)
      if (!Number.isNaN(prevRender)) maxStep = Math.max(maxStep, Math.abs(rx - prevRender))
      prevRender = rx
      sampled++
    }

    // One tick = 1/60 of a tile (~0.0167). A teleport would be a full tile (1.0) in one
    // frame. Allow generous slack for the odd multi-tick frame but stay far below a tile.
    expect(maxStep).toBeGreaterThan(0) // it actually moves
    expect(maxStep).toBeLessThan(0.2)
  })

  it('stays deterministic — prev* are render-only and never change the state hash', async () => {
    const a = await bootBelt(60)
    const b = await bootBelt(60)
    a.scheduler.runTicks(a.world, 500)
    b.scheduler.runTicks(b.world, 500)
    expect(hashState(a.world)).toBe(hashState(b.world))
  })

  it('a blocked item sits still — its render anchor never re-plays the last step', async () => {
    // No input port, so the belt backs up and items pile against the dead-end at tile 8.
    // A stuck item must render at its own tile every frame: before the fix its prev* stayed
    // one tile behind, so the renderer slid it forward and snapped it back every cycle.
    const sim = await bootBelt(10) // move once every 10 ticks so a whole cycle is easy to span
    const { Position } = sim.world.components
    const g = sim.state.grid
    sim.scheduler.runTicks(sim.world, 400) // long enough for the belt to fully back up

    // The item parked on the dead-end tile (8,0) — it can never advance.
    const lastTile = g.count - 1
    const stuck = g.slot[lastTile]!
    expect(stuck).not.toBe(-1)
    expect(Position.x[stuck]!).toBe(10)
    // Its render anchor coincides with its tile: lerp(prev, x, alpha) is constant.
    expect(Position.prevX[stuck]!).toBe(Position.x[stuck]!)
    expect(Position.prevY[stuck]!).toBe(Position.y[stuck]!)

    // Sample the interpolated x across a full move-cycle: it must not drift.
    let minX = Infinity
    let maxX = -Infinity
    for (let f = 0; f < 30; f++) {
      const sub = sim.scheduler.advance(sim.world, 1000 / 60)
      const rx = lerp(Position.prevX[stuck]!, Position.x[stuck]!, beltMoveAlpha(sim.state, sub))
      minX = Math.min(minX, rx)
      maxX = Math.max(maxX, rx)
    }
    expect(maxX - minX).toBe(0)
  })
})
