import type { Container } from 'pixi.js'
import { clamp, type GridCoord } from '@factory/shared'

/** A point in world-pixel space (pre-zoom). Distinct from {@link GridCoord}'s tile units. */
export interface WorldPoint {
  readonly x: number
  readonly y: number
}

/**
 * Frame-rate-independent exponential smoothing: the fraction to move toward a target this
 * frame so a given `rate` (per second) feels identical at any refresh rate.
 */
function smoothT(rate: number, dtMs: number): number {
  return 1 - Math.exp(-rate * (dtMs / 1000))
}

/**
 * Pan/zoom camera that transforms a single "world" container. Purely a view concern — it
 * never touches sim state. Its logical offset/zoom are the source of truth (mirrored onto the
 * container via {@link Camera.#apply}) so the smoothing math is testable without a GPU.
 *
 * Zoom and follow ease in over {@link Camera.update} calls driven by the render ticker;
 * keyboard/edge panning is applied directly via {@link Camera.panBy}, which also releases any
 * active follow so a manual nudge always wins.
 */
export class Camera {
  #x = 0
  #y = 0
  #zoom = 1
  #targetZoom = 1
  /** Screen-space focal point kept stationary while an in-flight zoom eases (e.g. the cursor). */
  #focalX = 0
  #focalY = 0
  /** When set, the world-pixel point eased toward the viewport centre each frame. */
  #follow: (() => WorldPoint) | null = null
  #viewW = 0
  #viewH = 0
  readonly minZoom = 0.2
  readonly maxZoom = 5
  /** Per-second easing rates for the zoom and follow animations. */
  readonly zoomRate = 16
  readonly followRate = 9

  constructor(private readonly world: Container) {}

  get zoom(): number {
    return this.#zoom
  }

  /** Whether a follow target is currently being tracked. */
  get following(): boolean {
    return this.#follow !== null
  }

  /** Record the viewport size (CSS px) used by centering/follow math. Call on resize. */
  setViewport(width: number, height: number): void {
    this.#viewW = width
    this.#viewH = height
  }

  /** Pan by a screen-space delta (pixels). A manual pan releases any active follow. */
  panBy(dx: number, dy: number): void {
    this.#follow = null
    this.#x += dx
    this.#y += dy
    this.#apply()
  }

  /**
   * Aim a smooth zoom toward a screen-space focal point (e.g. the cursor). The zoom eases in
   * over subsequent {@link update} calls, each keeping the tile under the focal point fixed.
   */
  zoomTo(focalX: number, focalY: number, factor: number): void {
    this.#targetZoom = clamp(this.#targetZoom * factor, this.minZoom, this.maxZoom)
    this.#focalX = focalX
    this.#focalY = focalY
  }

  /**
   * Smoothly track a world-pixel target, easing it toward the viewport centre each frame until a
   * manual pan releases it. Pass a constant point for a one-shot "glide to here"; pass `null` to
   * stop following.
   */
  follow(target: (() => WorldPoint) | null): void {
    this.#follow = target
  }

  /**
   * Advance camera smoothing by `dtMs`, called once per rendered frame. Eases the zoom toward
   * its target (holding the focal point fixed) and, when following, eases the view toward the
   * tracked target. A pure view update — it never reads or mutates sim state.
   */
  update(dtMs: number): void {
    let changed = false
    if (this.#zoom !== this.#targetZoom) {
      const prev = this.#zoom
      let next = this.#zoom + (this.#targetZoom - this.#zoom) * smoothT(this.zoomRate, dtMs)
      // Snap within a hair so the animation ends cleanly instead of creeping forever.
      if (Math.abs(next - this.#targetZoom) < 1e-3) next = this.#targetZoom
      this.#zoom = next
      // Keep the focal point stationary: adjust the offset by the same ratio the zoom moved,
      // relative to the *current* offset so a concurrent pan still composes correctly.
      const applied = next / prev
      this.#x = this.#focalX - (this.#focalX - this.#x) * applied
      this.#y = this.#focalY - (this.#focalY - this.#y) * applied
      changed = true
    }
    if (this.#follow) {
      const target = this.#follow()
      const desiredX = this.#viewW / 2 - target.x * this.#zoom
      const desiredY = this.#viewH / 2 - target.y * this.#zoom
      const t = smoothT(this.followRate, dtMs)
      this.#x += (desiredX - this.#x) * t
      this.#y += (desiredY - this.#y) * t
      changed = true
    }
    if (changed) this.#apply()
  }

  /**
   * The world-pixel rectangle currently framed by the viewport (the inverse of the view
   * transform applied to the two viewport corners). Used by the minimap to draw the "you are
   * here" box. A pure view→world read; never mutates the sim.
   */
  worldViewBounds(): { minX: number; minY: number; maxX: number; maxY: number } {
    return {
      minX: -this.#x / this.#zoom,
      minY: -this.#y / this.#zoom,
      maxX: (this.#viewW - this.#x) / this.#zoom,
      maxY: (this.#viewH - this.#y) / this.#zoom,
    }
  }

  /**
   * Convert a canvas-space pixel (e.g. a pointer position relative to the canvas) into the
   * integer tile under it. A pure view→world read; never mutates the sim.
   */
  screenToTile(screenX: number, screenY: number, tileSize: number): GridCoord {
    const worldX = (screenX - this.#x) / this.#zoom
    const worldY = (screenY - this.#y) / this.#zoom
    return { x: Math.floor(worldX / tileSize), y: Math.floor(worldY / tileSize) }
  }

  /** Immediately center the camera on a world-space pixel coordinate. */
  centerOn(worldX: number, worldY: number, viewWidth: number, viewHeight: number): void {
    this.setViewport(viewWidth, viewHeight)
    this.#x = viewWidth / 2 - worldX * this.#zoom
    this.#y = viewHeight / 2 - worldY * this.#zoom
    this.#apply()
  }

  /** Mirror the logical offset/zoom onto the Pixi container. The only place the view is touched. */
  #apply(): void {
    this.world.x = this.#x
    this.world.y = this.#y
    this.world.scale.set(this.#zoom)
  }
}
