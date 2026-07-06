import { describe, expect, it } from 'vitest'
import {
  minimapPanel,
  minimapFit,
  projectToMinimap,
  minimapToWorld,
  inMinimap,
  padBounds,
  mapBaseScale,
  mapScale,
  projectToMap,
  mapToWorld,
  zoomMapAround,
  type WorldBounds,
  type MapView,
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

describe('full-screen map projection', () => {
  const panel = { x: 0, y: 0, w: 200, h: 200 }
  const world: WorldBounds = { minX: 0, minY: 0, maxX: 100, maxY: 100 }

  it('base scale is the aspect fit of the world into the panel', () => {
    // 100 world px into 200 panel px → 2×.
    expect(mapBaseScale(world, panel)).toBe(2)
  })

  it('effective scale multiplies the base fit by the map zoom', () => {
    expect(mapScale(world, panel, { focusX: 0, focusY: 0, zoom: 3 })).toBe(6)
    expect(mapScale(world, panel, { focusX: 0, focusY: 0, zoom: 0.5 })).toBe(1)
  })

  it('projects the focus point to the panel centre', () => {
    const view: MapView = { focusX: 40, focusY: 60, zoom: 1 }
    expect(projectToMap(40, 60, world, panel, view)).toEqual({ x: 100, y: 100 })
  })

  it('scales offsets from the focus by the effective scale', () => {
    // focus at (50,50), zoom 2 → base 2 × zoom 2 = 4 px per world px.
    const view: MapView = { focusX: 50, focusY: 50, zoom: 2 }
    expect(projectToMap(60, 50, world, panel, view)).toEqual({ x: 100 + 10 * 4, y: 100 })
  })

  it('round-trips project → inverse for an off-centre point at a non-unit zoom', () => {
    const view: MapView = { focusX: 20, focusY: 70, zoom: 2.5 }
    const wp = { x: 33, y: 88 }
    const sp = projectToMap(wp.x, wp.y, world, panel, view)
    const back = mapToWorld(sp.x, sp.y, world, panel, view)
    expect(back.x).toBeCloseTo(wp.x, 6)
    expect(back.y).toBeCloseTo(wp.y, 6)
  })

  it('does not clamp the inverse to the world bounds (the map pans freely)', () => {
    const view: MapView = { focusX: 50, focusY: 50, zoom: 1 }
    // A point far outside the panel maps past the world bounds, unlike the clamped minimap.
    const wp = mapToWorld(-400, -400, world, panel, view)
    expect(wp.x).toBeLessThan(world.minX)
    expect(wp.y).toBeLessThan(world.minY)
  })
})

describe('zoomMapAround', () => {
  const panel = { x: 0, y: 0, w: 200, h: 200 }
  const world: WorldBounds = { minX: 0, minY: 0, maxX: 100, maxY: 100 }

  it('keeps the world point under the anchor fixed while zooming in', () => {
    const view: MapView = { focusX: 50, focusY: 50, zoom: 1 }
    const anchor = { x: 30, y: 160 }
    const before = mapToWorld(anchor.x, anchor.y, world, panel, view)
    const next = zoomMapAround(anchor.x, anchor.y, world, panel, view, 2, 0.25, 8)
    expect(next.zoom).toBe(2)
    const after = mapToWorld(anchor.x, anchor.y, world, panel, next)
    expect(after.x).toBeCloseTo(before.x, 6)
    expect(after.y).toBeCloseTo(before.y, 6)
  })

  it('clamps the zoom to [minZoom, maxZoom] and pins the anchor at the clamp', () => {
    const view: MapView = { focusX: 50, focusY: 50, zoom: 7 }
    const anchor = { x: 200, y: 0 }
    const before = mapToWorld(anchor.x, anchor.y, world, panel, view)
    // A ×4 request past maxZoom 8 clamps to 8.
    const next = zoomMapAround(anchor.x, anchor.y, world, panel, view, 4, 0.25, 8)
    expect(next.zoom).toBe(8)
    const after = mapToWorld(anchor.x, anchor.y, world, panel, next)
    expect(after.x).toBeCloseTo(before.x, 6)
    expect(after.y).toBeCloseTo(before.y, 6)
  })

  it('a no-op factor (past the max) leaves the focus unchanged', () => {
    const view: MapView = { focusX: 12, focusY: 34, zoom: 8 }
    const next = zoomMapAround(100, 100, world, panel, view, 2, 0.25, 8)
    expect(next).toEqual(view)
  })
})
