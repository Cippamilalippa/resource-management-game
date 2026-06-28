import { Application, Container, Graphics } from 'pixi.js'
import { lerp } from '@factory/shared'
import { TILE_SIZE, renderableEntities, type GameWorld } from '../core/index.ts'
import { Camera } from './camera.ts'

export interface RendererOptions {
  /** Existing canvas to render into. */
  canvas: HTMLCanvasElement
  /** Logical viewport size in CSS pixels. */
  width: number
  height: number
  /** Number of grid lines to draw out from the origin, each way. */
  gridExtent?: number
  background?: number
}

/**
 * Read-only PixiJS renderer. It NEVER mutates sim state — every frame it reads the
 * Position/Renderable component arrays and draws colored-rectangle placeholders,
 * interpolating between the previous and current tick using `alpha`.
 */
export class Renderer {
  #app: Application
  #world = new Container()
  #gridLayer = new Graphics()
  #entityLayer = new Container()
  #camera: Camera
  #sprites = new Map<number, Graphics>()
  readonly #gridExtent: number

  private constructor(app: Application, gridExtent: number) {
    this.#app = app
    this.#gridExtent = gridExtent
    this.#world.addChild(this.#gridLayer)
    this.#world.addChild(this.#entityLayer)
    this.#app.stage.addChild(this.#world)
    this.#camera = new Camera(this.#world)
    this.#drawGrid()
    this.#camera.centerOn(0, 0, app.screen.width, app.screen.height)
    this.#installInput()
  }

  static async create(opts: RendererOptions): Promise<Renderer> {
    const app = new Application()
    await app.init({
      canvas: opts.canvas,
      width: opts.width,
      height: opts.height,
      background: opts.background ?? 0x12141c,
      antialias: true,
      autoDensity: true,
      resolution: globalThis.devicePixelRatio || 1,
    })
    return new Renderer(app, opts.gridExtent ?? 64)
  }

  get camera(): Camera {
    return this.#camera
  }

  /**
   * Draw one frame. `alpha` (0..1) is the scheduler's interpolation factor between
   * the last two ticks. Reads sim state only.
   */
  render(gw: GameWorld, alpha: number): void {
    const { Position, Renderable } = gw.components
    const ents = renderableEntities(gw)
    const seen = new Set<number>()

    for (let i = 0; i < ents.length; i++) {
      const eid = ents[i]!
      seen.add(eid)

      let g = this.#sprites.get(eid)
      if (!g) {
        g = new Graphics()
        this.#sprites.set(eid, g)
        this.#entityLayer.addChild(g)
        this.#paintSprite(
          g,
          Renderable.color[eid]!,
          Renderable.width[eid]!,
          Renderable.height[eid]!,
        )
      }

      const x = lerp(Position.prevX[eid]!, Position.x[eid]!, alpha) * TILE_SIZE
      const y = lerp(Position.prevY[eid]!, Position.y[eid]!, alpha) * TILE_SIZE
      g.position.set(x, y)
    }

    // Drop graphics for entities that no longer exist.
    for (const [eid, g] of this.#sprites) {
      if (!seen.has(eid)) {
        g.destroy()
        this.#sprites.delete(eid)
      }
    }
  }

  resize(width: number, height: number): void {
    this.#app.renderer.resize(width, height)
  }

  destroy(): void {
    this.#app.destroy(false, { children: true })
    this.#sprites.clear()
  }

  #paintSprite(g: Graphics, color: number, wTiles: number, hTiles: number): void {
    const pad = 2
    g.clear()
    g.rect(pad, pad, wTiles * TILE_SIZE - pad * 2, hTiles * TILE_SIZE - pad * 2)
    g.fill(color)
  }

  #drawGrid(): void {
    const g = this.#gridLayer
    const extent = this.#gridExtent
    const min = -extent * TILE_SIZE
    const max = extent * TILE_SIZE
    g.clear()
    for (let i = -extent; i <= extent; i++) {
      const p = i * TILE_SIZE
      g.moveTo(p, min).lineTo(p, max)
      g.moveTo(min, p).lineTo(max, p)
    }
    g.stroke({ width: 1, color: 0x2a2e3a, alpha: 1 })
    // Emphasize the origin axes.
    g.moveTo(0, min).lineTo(0, max)
    g.moveTo(min, 0).lineTo(max, 0)
    g.stroke({ width: 2, color: 0x3d4452 })
  }

  #installInput(): void {
    const canvas = this.#app.canvas
    let dragging = false
    let lastX = 0
    let lastY = 0

    canvas.addEventListener('pointerdown', (e) => {
      dragging = true
      lastX = e.clientX
      lastY = e.clientY
    })
    globalThis.addEventListener('pointerup', () => {
      dragging = false
    })
    globalThis.addEventListener('pointermove', (e) => {
      if (!dragging) return
      this.#camera.panBy(e.clientX - lastX, e.clientY - lastY)
      lastX = e.clientX
      lastY = e.clientY
    })
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault()
        const rect = canvas.getBoundingClientRect()
        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1
        this.#camera.zoomAt(e.clientX - rect.left, e.clientY - rect.top, factor)
      },
      { passive: false },
    )
  }
}
