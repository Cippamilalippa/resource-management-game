import { describe, expect, it } from 'vitest'
import {
  minimapPanel,
  minimapFit,
  projectToMinimap,
  minimapToWorld,
  inMinimap,
  padBounds,
  type WorldBounds,
} from '../render/minimap.ts'

describe('minimapPanel', () => {
  it('pins a square to the bottom-right corner clear of the margin', () => {
    const p = minimapPanel(800, 600, { size: 180, margin: 12 })
    expect(p).toEqual({ x: 800 - 12 - 180, y: 600 - 12 - 180, w: 180, h: 180 })
  })

  it('shrinks so it never overflows a tiny viewport', () => {
    const p = minimapPanel(100, 80, { size: 180, margin: 12 })
    expect(p.w).toBe(100 - 24)
    expect(p.h).toBe(80 - 24)
    expect(p.x).toBe(12)
    expect(p.y).toBe(12)
  })
})

describe('minimap projection', () => {
  const panel = { x: 0, y: 0, w: 100, h: 100 }

  it('fits a square world edge-to-edge (scale = panel/world, no letterbox)', () => {
    const world: WorldBounds = { minX: 0, minY: 0, maxX: 200, maxY: 200 }
    const fit = minimapFit(world, panel)
    expect(fit.scale).toBe(0.5)
    expect(fit.contentX).toBe(0)
    expect(fit.contentY).toBe(0)
  })

  it('preserves aspect ratio and letterboxes a wide world', () => {
    // Twice as wide as tall → fit to width, centre vertically.
    const world: WorldBounds = { minX: 0, minY: 0, maxX: 200, maxY: 100 }
    const fit = minimapFit(world, panel)
    expect(fit.scale).toBe(0.5)
    expect(fit.contentX).toBe(0)
    expect(fit.contentY).toBe(25) // (100 - 100*0.5)/2
  })

  it('projects the world corners onto the content rect', () => {
    const world: WorldBounds = { minX: -50, minY: -50, maxX: 50, maxY: 50 }
    expect(projectToMinimap(-50, -50, world, panel)).toEqual({ x: 0, y: 0 })
    expect(projectToMinimap(50, 50, world, panel)).toEqual({ x: 100, y: 100 })
    expect(projectToMinimap(0, 0, world, panel)).toEqual({ x: 50, y: 50 })
  })

  it('round-trips project → inverse for an interior point', () => {
    const world: WorldBounds = { minX: -30, minY: 10, maxX: 90, maxY: 130 }
    const wp = { x: 12, y: 44 }
    const sp = projectToMinimap(wp.x, wp.y, world, panel)
    const back = minimapToWorld(sp.x, sp.y, world, panel)
    expect(back.x).toBeCloseTo(wp.x, 6)
    expect(back.y).toBeCloseTo(wp.y, 6)
  })

  it('clamps an out-of-panel click back onto the world bounds', () => {
    const world: WorldBounds = { minX: 0, minY: 0, maxX: 100, maxY: 100 }
    // A click well past the panel maps to the far world corner, not beyond it.
    const w = minimapToWorld(999, 999, world, panel)
    expect(w).toEqual({ x: 100, y: 100 })
  })
})

describe('inMinimap', () => {
  const panel = { x: 10, y: 20, w: 100, h: 100 }
  it('hit-tests points against the panel rect', () => {
    expect(inMinimap(10, 20, panel)).toBe(true)
    expect(inMinimap(110, 120, panel)).toBe(true)
    expect(inMinimap(60, 70, panel)).toBe(true)
    expect(inMinimap(9, 70, panel)).toBe(false)
    expect(inMinimap(60, 121, panel)).toBe(false)
  })
})

describe('padBounds', () => {
  it('grows the bounds by pad on every side', () => {
    const b: WorldBounds = { minX: 0, minY: 0, maxX: 10, maxY: 10 }
    expect(padBounds(b, 5)).toEqual({ minX: -5, minY: -5, maxX: 15, maxY: 15 })
  })
})
