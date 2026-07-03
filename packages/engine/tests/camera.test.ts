import { describe, expect, it } from 'vitest'
import type { Container } from 'pixi.js'
import { Camera } from '../render/camera.ts'

/**
 * The Camera's only runtime dependency is `@factory/shared` (the `pixi.js` import is type-only,
 * erased at build), so a structural stub of the bits it touches — `x`, `y`, `scale.set` — lets us
 * unit-test the pan/zoom/follow math without a GPU. This mirrors the container the renderer hands it.
 */
interface FakeWorld {
  x: number
  y: number
  scale: { value: number; set(v: number): void }
}

function fakeWorld(): FakeWorld & Container {
  const world: FakeWorld = {
    x: 0,
    y: 0,
    // The renderer's container exposes `scale.set(v)`; record the value for assertions.
    scale: {
      value: 1,
      set(v: number): void {
        this.value = v
      },
    },
  }
  return world as unknown as FakeWorld & Container
}

/** Run `update` `n` times at a fixed frame delta to let an animation converge. */
function settle(cam: Camera, n = 300, dtMs = 16): void {
  for (let i = 0; i < n; i++) cam.update(dtMs)
}

describe('Camera', () => {
  it('centers a world point in the viewport', () => {
    const world = fakeWorld()
    const cam = new Camera(world)
    cam.centerOn(0, 0, 800, 600)
    expect(world.x).toBe(400)
    expect(world.y).toBe(300)
    expect(cam.zoom).toBe(1)
  })

  it('pans by a screen delta and mirrors it onto the container', () => {
    const world = fakeWorld()
    const cam = new Camera(world)
    cam.centerOn(0, 0, 800, 600)
    cam.panBy(10, -5)
    expect(world.x).toBe(410)
    expect(world.y).toBe(295)
  })

  it('maps a screen pixel to the tile under it, before and after zoom', () => {
    const world = fakeWorld()
    const cam = new Camera(world)
    cam.centerOn(0, 0, 800, 600) // origin tile is centred at (400, 300)
    expect(cam.screenToTile(400, 300, 32)).toEqual({ x: 0, y: 0 })
    expect(cam.screenToTile(400 + 32, 300, 32)).toEqual({ x: 1, y: 0 })
    expect(cam.screenToTile(400 - 1, 300, 32)).toEqual({ x: -1, y: 0 })
  })

  it('eases zoom toward its target and clamps to the range', () => {
    const world = fakeWorld()
    const cam = new Camera(world)
    cam.centerOn(0, 0, 800, 600)
    cam.zoomTo(400, 300, 2)
    // One frame moves partway, not all the way.
    cam.update(16)
    expect(cam.zoom).toBeGreaterThan(1)
    expect(cam.zoom).toBeLessThan(2)
    settle(cam)
    expect(cam.zoom).toBe(2)
    // The zoom is mirrored onto the container's scale.
    expect(world.scale.value).toBe(2)

    // A huge factor clamps the target to maxZoom.
    cam.zoomTo(400, 300, 100)
    settle(cam)
    expect(cam.zoom).toBe(cam.maxZoom)
  })

  it('keeps the focal point stationary throughout a zoom animation', () => {
    const world = fakeWorld()
    const cam = new Camera(world)
    cam.centerOn(0, 0, 800, 600)
    const [fx, fy] = [600, 200]
    const worldUnder = (): { x: number; y: number } => ({
      x: (fx - world.x) / cam.zoom,
      y: (fy - world.y) / cam.zoom,
    })
    const before = worldUnder()
    cam.zoomTo(fx, fy, 3)
    // The tile under the focal pixel must not drift on any intermediate frame.
    for (let i = 0; i < 60; i++) {
      cam.update(16)
      const now = worldUnder()
      expect(now.x).toBeCloseTo(before.x, 6)
      expect(now.y).toBeCloseTo(before.y, 6)
    }
  })

  it('follows a target toward the viewport centre until a manual pan releases it', () => {
    const world = fakeWorld()
    const cam = new Camera(world)
    cam.centerOn(0, 0, 800, 600)
    const target = { x: 100, y: 40 }
    cam.follow(() => target)
    expect(cam.following).toBe(true)
    settle(cam)
    // Target world-px should sit at the viewport centre: offset = center - target*zoom.
    expect(world.x).toBeCloseTo(400 - 100, 3)
    expect(world.y).toBeCloseTo(300 - 40, 3)

    cam.panBy(25, 0)
    expect(cam.following).toBe(false)
    const after = world.x
    // With follow released, further updates no longer pull the view back toward the target.
    settle(cam, 30)
    expect(world.x).toBe(after)
  })

  it('does nothing on update when idle (no zoom animation, no follow)', () => {
    const world = fakeWorld()
    const cam = new Camera(world)
    cam.centerOn(0, 0, 800, 600)
    const [x, y, z] = [world.x, world.y, cam.zoom]
    settle(cam, 10)
    expect(world.x).toBe(x)
    expect(world.y).toBe(y)
    expect(cam.zoom).toBe(z)
  })
})
