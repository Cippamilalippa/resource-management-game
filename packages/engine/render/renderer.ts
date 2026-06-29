import { Application, Container, Graphics } from 'pixi.js'
import { lerp, type GridCoord } from '@factory/shared'
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
 * A translucent placement preview drawn over the world. The renderer only draws it
 * — the app decides what (if anything) to show, based on the selected build tool.
 */
export type Ghost =
  | {
      readonly kind: 'rect'
      readonly x: number
      readonly y: number
      readonly w: number
      readonly h: number
      readonly color: number
    }
  | {
      readonly kind: 'line'
      readonly ax: number
      readonly ay: number
      readonly bx: number
      readonly by: number
      readonly color: number
    }

/**
 * A selection/hover outline drawn over an object's full footprint. Like {@link Ghost}
 * the renderer only draws it; the app decides what (if anything) is under the cursor.
 * `selected` distinguishes a transient hover (faint) from a pinned selection (bold).
 */
export interface Highlight {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly color: number
  readonly selected: boolean
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
  #ghostLayer = new Graphics()
  #highlightLayer = new Graphics()
  #camera: Camera
  #sprites = new Map<number, Graphics>()
  /** Last `sprite` value painted per entity, so a changed glyph triggers a repaint. */
  #spriteVals = new Map<number, number>()
  /**
   * Last `color` value painted per entity. The engine recycles entity ids (bitecs), so a
   * cached graphics can be handed to a *different* entity that happens to reuse the id — and
   * a belt item consumed at an input is reborn at an output on the very same tick. Repainting
   * only on a `sprite` change would then leave the recycled sprite showing the old item's
   * colour; tracking colour too forces a repaint whenever the glyph OR the colour changes.
   */
  #colorVals = new Map<number, number>()
  readonly #gridExtent: number

  /** Called when the pointer moves over a new tile. */
  onTileHover: ((tile: GridCoord) => void) | null = null
  /** Called when the pointer is pressed on a tile — the start of a drag gesture. */
  onDragStart: ((tile: GridCoord) => void) | null = null
  /** Called as the pointer moves while pressed — a drag-gesture update. */
  onDragMove: ((tile: GridCoord) => void) | null = null
  /**
   * Called when the pointer is released — the end of a drag gesture. A press and
   * release on the same tile (no movement) is a click: the same hook fires with the
   * end tile equal to the start tile.
   */
  onDragEnd: ((tile: GridCoord) => void) | null = null

  private constructor(app: Application, gridExtent: number) {
    this.#app = app
    this.#gridExtent = gridExtent
    this.#world.addChild(this.#gridLayer)
    this.#world.addChild(this.#entityLayer)
    this.#world.addChild(this.#ghostLayer)
    this.#world.addChild(this.#highlightLayer)
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

      const spr = Renderable.sprite[eid]!
      const color = Renderable.color[eid]!
      let g = this.#sprites.get(eid)
      if (!g) {
        g = new Graphics()
        this.#sprites.set(eid, g)
        this.#entityLayer.addChild(g)
        this.#paintSprite(g, spr, color, Renderable.width[eid]!, Renderable.height[eid]!)
        this.#spriteVals.set(eid, spr)
        this.#colorVals.set(eid, color)
      } else if (this.#spriteVals.get(eid) !== spr || this.#colorVals.get(eid) !== color) {
        // The glyph or colour changed — e.g. a belt tile re-aimed by redrawing over it, or
        // a recycled entity id now hosting a different item: repaint so the cached graphics
        // never keeps a stale glyph/colour from the entity that previously held this id.
        this.#paintSprite(g, spr, color, Renderable.width[eid]!, Renderable.height[eid]!)
        this.#spriteVals.set(eid, spr)
        this.#colorVals.set(eid, color)
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
        this.#spriteVals.delete(eid)
        this.#colorVals.delete(eid)
      }
    }
  }

  /** Show (or clear, with `null`) the translucent placement preview. */
  setGhost(ghost: Ghost | null): void {
    const g = this.#ghostLayer
    g.clear()
    if (!ghost) return
    if (ghost.kind === 'rect') {
      g.rect(ghost.x * TILE_SIZE, ghost.y * TILE_SIZE, ghost.w * TILE_SIZE, ghost.h * TILE_SIZE)
      g.fill({ color: ghost.color, alpha: 0.45 })
      g.stroke({ width: 2, color: ghost.color, alpha: 0.9 })
      return
    }
    // Line: a one-tile-thick band covering the bounding box of A..B.
    const minX = Math.min(ghost.ax, ghost.bx)
    const minY = Math.min(ghost.ay, ghost.by)
    const w = Math.abs(ghost.bx - ghost.ax) + 1
    const h = Math.abs(ghost.by - ghost.ay) + 1
    g.rect(minX * TILE_SIZE, minY * TILE_SIZE, w * TILE_SIZE, h * TILE_SIZE)
    g.fill({ color: ghost.color, alpha: 0.45 })
    g.stroke({ width: 2, color: ghost.color, alpha: 0.9 })
  }

  /**
   * Show (or clear, with `null`) the hover/selection outline over an object's footprint.
   * A hover is a faint outline; a pinned selection is bold with corner ticks. Purely a
   * visual read of sim state — it never mutates the world.
   */
  setHighlight(h: Highlight | null): void {
    const g = this.#highlightLayer
    g.clear()
    if (!h) return
    const px = h.x * TILE_SIZE
    const py = h.y * TILE_SIZE
    const pw = h.w * TILE_SIZE
    const ph = h.h * TILE_SIZE
    const width = h.selected ? 3 : 2
    g.rect(px, py, pw, ph)
    g.fill({ color: h.color, alpha: h.selected ? 0.14 : 0.07 })
    g.stroke({ width, color: h.color, alpha: h.selected ? 1 : 0.75 })
    if (!h.selected) return
    // Selected: short corner ticks to read as a "locked" selection rather than a hover.
    const len = Math.min(TILE_SIZE * 0.5, pw / 2, ph / 2)
    for (const [cx, cy, sx, sy] of [
      [px, py, 1, 1],
      [px + pw, py, -1, 1],
      [px, py + ph, 1, -1],
      [px + pw, py + ph, -1, -1],
    ] as const) {
      g.moveTo(cx, cy).lineTo(cx + sx * len, cy)
      g.moveTo(cx, cy).lineTo(cx, cy + sy * len)
    }
    g.stroke({ width: width + 1, color: h.color, alpha: 1 })
  }

  resize(width: number, height: number): void {
    this.#app.renderer.resize(width, height)
  }

  destroy(): void {
    this.#app.destroy(false, { children: true })
    this.#sprites.clear()
  }

  /**
   * Paint one entity's placeholder glyph. `sprite` is an opaque shape id the engine
   * decodes into a handful of primitives — `shape = sprite >> 2`, `orient = sprite & 3`
   * (a direction 0=N,1=E,2=S,3=W). The engine assigns no game meaning; content does.
   */
  #paintSprite(g: Graphics, sprite: number, color: number, wTiles: number, hTiles: number): void {
    const shape = sprite >> 2
    const orient = sprite & 3
    const pad = 2
    g.clear()
    switch (shape) {
      case 1: {
        // Circle — a small item riding a belt.
        g.circle(TILE_SIZE / 2, TILE_SIZE / 2, TILE_SIZE * 0.28)
        g.fill(color)
        g.stroke({ width: 1, color: 0x000000, alpha: 0.3 })
        return
      }
      case 2: {
        // Belt track: a faint tile with a direction chevron.
        g.rect(pad, pad, TILE_SIZE - pad * 2, TILE_SIZE - pad * 2)
        g.fill({ color, alpha: 0.3 })
        this.#chevron(g, orient, TILE_SIZE / 2, TILE_SIZE / 2, TILE_SIZE * 0.3, 0xffffff, 0.55)
        return
      }
      case 3: {
        // Input/output port: a solid tile with one bold direction chevron.
        g.rect(pad, pad, TILE_SIZE - pad * 2, TILE_SIZE - pad * 2)
        g.fill({ color, alpha: 0.85 })
        this.#chevron(g, orient, TILE_SIZE / 2, TILE_SIZE / 2, TILE_SIZE * 0.34, 0xffffff, 0.95)
        return
      }
      case 4: {
        // Splitter: three stacked chevrons across the perpendicular axis.
        g.rect(pad, pad, TILE_SIZE - pad * 2, TILE_SIZE - pad * 2)
        g.fill({ color, alpha: 0.85 })
        const ux = orient === 1 ? 1 : orient === 3 ? -1 : 0
        const uy = orient === 0 ? -1 : orient === 2 ? 1 : 0
        const off = TILE_SIZE * 0.26
        for (let i = -1; i <= 1; i++) {
          const cx = TILE_SIZE / 2 + -uy * off * i
          const cy = TILE_SIZE / 2 + ux * off * i
          this.#chevron(g, orient, cx, cy, TILE_SIZE * 0.16, 0xffffff, 0.95)
        }
        return
      }
      default: {
        // Rect — buildings, scenery (the default placeholder).
        g.rect(pad, pad, wTiles * TILE_SIZE - pad * 2, hTiles * TILE_SIZE - pad * 2)
        g.fill(color)
      }
    }
  }

  /**
   * Draw a filled triangular chevron centered at (cx, cy) pointing in `orient`
   * (0=N,1=E,2=S,3=W), of half-length `half`. Used for belt/port/splitter glyphs.
   */
  #chevron(
    g: Graphics,
    orient: number,
    cx: number,
    cy: number,
    half: number,
    color: number,
    alpha: number,
  ): void {
    const ux = orient === 1 ? 1 : orient === 3 ? -1 : 0
    const uy = orient === 0 ? -1 : orient === 2 ? 1 : 0
    // Perpendicular for the base corners.
    const px = -uy
    const py = ux
    const wid = half * 0.85
    g.poly([
      cx + ux * half,
      cy + uy * half,
      cx - ux * half + px * wid,
      cy - uy * half + py * wid,
      cx - ux * half - px * wid,
      cy - uy * half - py * wid,
    ])
    g.fill({ color, alpha })
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
    let pressed = false

    const tileAt = (clientX: number, clientY: number): GridCoord => {
      const rect = canvas.getBoundingClientRect()
      return this.#camera.screenToTile(clientX - rect.left, clientY - rect.top, TILE_SIZE)
    }

    // The pointer now drives placement only — panning is on the keyboard (WASD). A
    // press starts a gesture, moves update it, and release ends it.
    canvas.addEventListener('pointerdown', (e) => {
      pressed = true
      if (this.onDragStart) this.onDragStart(tileAt(e.clientX, e.clientY))
    })
    globalThis.addEventListener('pointerup', (e) => {
      if (pressed && this.onDragEnd) this.onDragEnd(tileAt(e.clientX, e.clientY))
      pressed = false
    })
    globalThis.addEventListener('pointermove', (e) => {
      const tile = tileAt(e.clientX, e.clientY)
      if (pressed && this.onDragMove) this.onDragMove(tile)
      if (this.onTileHover) this.onTileHover(tile)
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

    this.#installKeyboardPan()
  }

  /**
   * Pan the camera while WASD keys are held. The actual move happens on the Pixi
   * ticker so panning is smooth and frame-rate independent (speed is in CSS px/sec).
   */
  #installKeyboardPan(): void {
    const PAN_PX_PER_SEC = 700
    const PAN_KEYS = new Set(['w', 'a', 's', 'd'])
    const held = new Set<string>()

    globalThis.addEventListener('keydown', (e) => {
      const k = e.key.toLowerCase()
      if (PAN_KEYS.has(k)) held.add(k)
    })
    globalThis.addEventListener('keyup', (e) => held.delete(e.key.toLowerCase()))
    // A key released while the window is unfocused never fires keyup; clear to be safe.
    globalThis.addEventListener('blur', () => held.clear())

    this.#app.ticker.add((ticker) => {
      if (held.size === 0) return
      const step = PAN_PX_PER_SEC * (ticker.deltaMS / 1000)
      let dx = 0
      let dy = 0
      if (held.has('a')) dx += step
      if (held.has('d')) dx -= step
      if (held.has('w')) dy += step
      if (held.has('s')) dy -= step
      this.#camera.panBy(dx, dy)
    })
  }
}
