import type { Container } from 'pixi.js'
import { clamp, type GridCoord } from '@factory/shared'

/**
 * Pan/zoom camera that transforms a single "world" container. Purely a view
 * concern — it never touches sim state.
 */
export class Camera {
  #zoom = 1
  readonly minZoom = 0.2
  readonly maxZoom = 5

  constructor(private readonly world: Container) {}

  get zoom(): number {
    return this.#zoom
  }

  /** Pan by a screen-space delta (pixels). */
  panBy(dx: number, dy: number): void {
    this.world.x += dx
    this.world.y += dy
  }

  /**
   * Zoom toward a screen-space focal point (e.g. the cursor) so the tile under the
   * cursor stays put as the player scrolls.
   */
  zoomAt(focalX: number, focalY: number, factor: number): void {
    const next = clamp(this.#zoom * factor, this.minZoom, this.maxZoom)
    const applied = next / this.#zoom
    // Keep the focal point stationary in world space.
    this.world.x = focalX - (focalX - this.world.x) * applied
    this.world.y = focalY - (focalY - this.world.y) * applied
    this.#zoom = next
    this.world.scale.set(this.#zoom)
  }

  /**
   * Convert a canvas-space pixel (e.g. a pointer position relative to the canvas)
   * into the integer tile under it. A pure view→world read; never mutates the sim.
   */
  screenToTile(screenX: number, screenY: number, tileSize: number): GridCoord {
    const worldX = (screenX - this.world.x) / this.#zoom
    const worldY = (screenY - this.world.y) / this.#zoom
    return { x: Math.floor(worldX / tileSize), y: Math.floor(worldY / tileSize) }
  }

  /** Center the camera on a world-space pixel coordinate. */
  centerOn(worldX: number, worldY: number, viewWidth: number, viewHeight: number): void {
    this.world.x = viewWidth / 2 - worldX * this.#zoom
    this.world.y = viewHeight / 2 - worldY * this.#zoom
    this.world.scale.set(this.#zoom)
  }
}
