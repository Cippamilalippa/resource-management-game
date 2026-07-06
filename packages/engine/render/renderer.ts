import { Application, Container, Graphics, Sprite, Text, type Texture } from 'pixi.js'
import { lerp, type GridCoord } from '@factory/shared'
import { TILE_SIZE, renderableEntities, type GameWorld } from '../core/index.ts'
import { Camera } from './camera.ts'
import {
  minimapPanel,
  minimapFit,
  minimapToWorld,
  inMinimap,
  padBounds,
  type MinimapRect,
  type WorldBounds,
} from './minimap.ts'

/**
 * The belt flow-arrow sign as a path of `[forward, lateral]` points in tile-fraction units,
 * authored pointing east (forward = +x) and centred on the tile. A chunky swallowtail: tip →
 * top shoulder → top back corner → notched centre → bottom back corner → bottom shoulder. The
 * SVG-equivalent path is `M .4 0 L 0 .4 L -.4 .4 L 0 0 L -.4 -.4 L 0 -.4 Z`. {@link Renderer.#beltArrow}
 * scales it by `TILE_SIZE` and rotates it onto the travel axis. Half-extent 0.4 = near-full-tile.
 */
const BELT_ARROW: readonly (readonly [number, number])[] = [
  [0.4, 0],
  [0, 0.4],
  [-0.4, 0.4],
  [0, 0],
  [-0.4, -0.4],
  [0, -0.4],
]

/** Green ring on a placement ghost the sim would accept — a "clear to place" signal. */
const GHOST_VALID = 0x55ff88
/** Red fill+ring on a placement ghost the sim would reject (off-terrain, overlapping, unaffordable). */
const GHOST_INVALID = 0xff5555

/** Duration (ms) of the scale+fade "pop" when an entity first appears. */
const SPAWN_MS = 160
/** Duration (ms) of the scale+fade dissolve when an entity is removed. */
const REMOVE_MS = 150

/**
 * Top-of-panel silhouette motifs a building glyph can wear so different *kinds* of structure read
 * apart at a glance (the specific machine is still identified by its centred icon). The engine
 * assigns them no game meaning — content (the base game) maps its own categories onto these ids.
 * `NONE` is the plain framed panel; the others add a distinct cap above the icon plate.
 */
const CAP_NONE = 0
const CAP_DRILL = 1 // downward wedge — an extractor biting into the ground
const CAP_DOME = 2 // rounded cap — a lab / research dome
const CAP_ROOF = 3 // gabled roofline — a depot / warehouse
const CAP_STACKS = 4 // twin chimneys — a raw producer

/**
 * Shade a packed `0xRRGGBB` colour toward white (`f > 0`) or black (`f < 0`) by fraction `|f|`.
 * A pure, allocation-free helper the building glyph uses to fake a bezel + top-light without any
 * art assets — a darker frame, the base face, and a lighter top highlight are all derived from the
 * entity's single authored colour, so the renderer stays game-agnostic.
 */
function shade(color: number, f: number): number {
  const r = (color >> 16) & 0xff
  const g = (color >> 8) & 0xff
  const b = color & 0xff
  const mix = (c: number): number =>
    f >= 0 ? Math.round(c + (255 - c) * f) : Math.round(c * (1 + f))
  return (mix(r) << 16) | (mix(g) << 8) | mix(b)
}

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
      /** Optional facing 0..3 (N,E,S,W): when set, draw a direction chevron (port rotation). */
      readonly dir?: number
      /**
       * Optional placement validity. When set, the ghost reads as a go/no-go signal rather than a
       * plain tint: `true` rings the footprint green (clear to place), `false` fills it red (blocked
       * — off-terrain, overlapping, or unaffordable). Left unset for previews with no validity
       * meaning (e.g. a belt's start-tile cursor).
       */
      readonly valid?: boolean
    }
  | {
      readonly kind: 'line'
      readonly ax: number
      readonly ay: number
      readonly bx: number
      readonly by: number
      readonly color: number
      /** Optional readout drawn at the line's end tile (e.g. a drag length "×5"). */
      readonly label?: string
      /**
       * Optional bend: when set, the band is drawn as an L — A -> corner along one axis, then
       * corner -> B along the other — instead of a single straight bounding box. Used by the
       * L-shaped belt drag preview so both legs show; the label still reads at B. The renderer
       * stays game-agnostic — it just draws whatever polyline the app hands it.
       */
      readonly corner?: { readonly x: number; readonly y: number }
    }
  | {
      /** A multi-cell preview (blueprint paste): a set of tinted footprint rects. */
      readonly kind: 'cells'
      readonly cells: readonly {
        readonly x: number
        readonly y: number
        readonly w: number
        readonly h: number
        readonly color: number
        /** Optional facing 0..3 (port cells) — draws a direction chevron like a rect ghost. */
        readonly dir?: number
      }[]
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

/** One status-overlay marker: a tinted footprint at a flagged tile (default 1×1). */
export interface StatusMark {
  readonly x: number
  readonly y: number
  readonly w?: number
  readonly h?: number
  readonly color: number
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
  /** Pulsing "working" halos, one redraw per frame, framed just above the entities they ring. */
  #pulseLayer = new Graphics()
  #iconLayer = new Container()
  #ghostLayer = new Graphics()
  #highlightLayer = new Graphics()
  #overlayLayer = new Graphics()
  /** A small readout drawn at a ghost line's end (e.g. a drag length). Hidden unless a label is set. */
  #ghostLabel = new Text({
    text: '',
    style: { fill: 0xffffff, fontSize: 13, fontFamily: 'monospace', fontWeight: 'bold' },
  })
  #camera: Camera
  #sprites = new Map<number, Graphics>()
  /**
   * Entities mid "pop-in": eid → elapsed ms. While present the sprite scales up from a shrunk,
   * translucent state to full size; cleared once the animation completes. Purely cosmetic.
   */
  #spawnAnim = new Map<number, number>()
  /**
   * Entities animating OUT after their sim entity vanished. We keep the graphics (and its icon)
   * alive a beat longer to fade+shrink them, then destroy. Keyed by the now-dead eid; a recycled
   * id reused before the fade finishes cancels the fade (see the top of {@link render}).
   */
  #dying = new Map<number, { g: Graphics; icon: Sprite | null; t: number }>()
  /** Free-running clock (ms) driving the active-crafter pulse; advanced by real frame time. */
  #pulseClock = 0
  /** `performance.now()` of the previous {@link render} call, for a wall-clock frame delta. */
  #lastRenderMs = 0
  /**
   * Screen-space overview map, pinned to a corner (a direct stage child, so the camera transform
   * that pans/zooms {@link #world} never moves it). Redrawn each frame from live entity positions.
   */
  #minimapLayer = new Graphics()
  /** Panel geometry + world bounds from the last minimap draw, reused to hit-test/navigate clicks. */
  #minimapPanel: MinimapRect | null = null
  #minimapWorld: WorldBounds | null = null
  #minimapConfig = { size: 180, margin: 12 }
  /**
   * When false the minimap is hidden and stops handling clicks. The app flips this off while a
   * modal (save menu, help) is up or in the menu shell, mirroring {@link edgeScroll}.
   */
  minimap = true
  /**
   * Optional per-entity overlay glyph, keyed by the entity's packed `color`. The engine stays
   * game-agnostic: the app supplies whatever textures it likes (here, the build-bar lucide
   * icon rasterized per building/producer colour) via {@link setIcons}; the renderer just draws
   * the matching one in the tile's top-right corner. Empty until the app populates it.
   */
  #iconTextures: ReadonlyMap<number, Texture> = new Map()
  /** Live overlay sprites, one per entity that currently has a matching icon texture. */
  #iconSprites = new Map<number, Sprite>()
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
  /**
   * Last pointer position (client px) and whether it is over the canvas — so keyboard actions
   * (Q pick, F focus) can resolve the tile under the cursor, and edge panning knows the cursor
   * is on screen, without a pointer event of their own.
   */
  #lastClientX = 0
  #lastClientY = 0
  #pointerInside = false
  /**
   * When false, edge-of-screen panning is suppressed. The app flips this off while a modal (save
   * menu, help) is open so the camera doesn't drift under the overlay.
   */
  edgeScroll = true

  /** Called when the pointer moves over a new tile. */
  onTileHover: ((tile: GridCoord) => void) | null = null
  /** Called when the pointer is pressed on a tile — the start of a drag gesture. */
  onDragStart: ((tile: GridCoord) => void) | null = null
  /**
   * Called as the pointer moves while pressed — a drag-gesture update. `shiftKey` relays whether
   * Shift is held (a generic modifier bit — e.g. the belt drag flips its L corner), leaving the
   * renderer game-agnostic.
   */
  onDragMove: ((tile: GridCoord, shiftKey: boolean) => void) | null = null
  /**
   * Called when the pointer is released — the end of a drag gesture. A press and
   * release on the same tile (no movement) is a click: the same hook fires with the
   * end tile equal to the start tile. `shiftKey` relays whether Shift was held (see
   * {@link onDragMove}).
   */
  onDragEnd: ((tile: GridCoord, shiftKey: boolean) => void) | null = null
  /** Called when the rotate key (R) is pressed — the app rotates the armed placement. */
  onRotate: (() => void) | null = null
  /**
   * Called when the pick key (Q) is pressed — the app arms the build tool matching whatever is
   * under the cursor ("pipette"). `copyConfig` is true when Shift is held (Shift+Q), asking the app
   * to also adopt the picked object's settings (e.g. a crafter's recipe). The renderer resolves the
   * tile from the last pointer position and relays it; it never mutates sim state.
   */
  onPick: ((tile: GridCoord, copyConfig: boolean) => void) | null = null
  /**
   * Called on mouse-wheel with the scroll delta before the camera zooms. The app returns true to
   * claim the wheel (e.g. rotate an armed port's facing) and suppress zoom; false to let it zoom.
   * The renderer never mutates sim state — it only relays the intent.
   */
  onWheel: ((deltaY: number) => boolean) | null = null
  /**
   * Called when the pointer is right-clicked (context menu) — the app cancels the current
   * gesture/armed tool. The renderer suppresses the native browser menu and never mutates
   * sim state; what "cancel" means is the app's to decide.
   */
  onCancel: (() => void) | null = null

  private constructor(app: Application, gridExtent: number) {
    this.#app = app
    this.#gridExtent = gridExtent
    this.#world.addChild(this.#gridLayer)
    this.#world.addChild(this.#entityLayer)
    this.#world.addChild(this.#pulseLayer)
    this.#world.addChild(this.#iconLayer)
    this.#world.addChild(this.#ghostLayer)
    this.#world.addChild(this.#highlightLayer)
    this.#world.addChild(this.#overlayLayer)
    this.#ghostLabel.visible = false
    this.#ghostLabel.zIndex = 10
    this.#world.addChild(this.#ghostLabel)
    this.#app.stage.addChild(this.#world)
    // The minimap lives on the stage (not #world) so it stays fixed to the screen corner.
    this.#app.stage.addChild(this.#minimapLayer)
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
    const { Position, Renderable, RenderHints } = gw.components
    const ents = renderableEntities(gw)
    const seen = new Set<number>()

    // Wall-clock frame delta drives the (sim-independent) cosmetic animations. Clamp so a
    // stall or a backgrounded tab can't fast-forward a pop, and seed the first frame at ~60fps.
    const now = performance.now()
    const dt = this.#lastRenderMs === 0 ? 16 : Math.min(100, now - this.#lastRenderMs)
    this.#lastRenderMs = now
    this.#pulseClock += dt
    // Shared pulse phase (0..1) for every active entity this frame.
    const pulse = 0.5 - 0.5 * Math.cos(this.#pulseClock * 0.006)

    this.#pulseLayer.clear()
    let anyPulse = false

    for (let i = 0; i < ents.length; i++) {
      const eid = ents[i]!
      seen.add(eid)

      // A recycled id that is still mid-fade-out: kill the fading ghost before reusing the id.
      const dead = this.#dying.get(eid)
      if (dead) {
        dead.g.destroy()
        if (dead.icon) dead.icon.destroy()
        this.#dying.delete(eid)
      }

      const spr = Renderable.sprite[eid]!
      const color = Renderable.color[eid]!
      const wTiles = Renderable.width[eid]!
      const hTiles = Renderable.height[eid]!
      let g = this.#sprites.get(eid)
      if (!g) {
        g = new Graphics()
        this.#sprites.set(eid, g)
        this.#entityLayer.addChild(g)
        this.#paintSprite(g, spr, color, wTiles, hTiles)
        this.#spriteVals.set(eid, spr)
        this.#colorVals.set(eid, color)
        this.#spawnAnim.set(eid, 0)
      } else if (this.#spriteVals.get(eid) !== spr || this.#colorVals.get(eid) !== color) {
        // The glyph or colour changed — e.g. a belt tile re-aimed by redrawing over it, or
        // a recycled entity id now hosting a different item: repaint so the cached graphics
        // never keeps a stale glyph/colour from the entity that previously held this id.
        this.#paintSprite(g, spr, color, wTiles, hTiles)
        this.#spriteVals.set(eid, spr)
        this.#colorVals.set(eid, color)
      }

      const x = lerp(Position.prevX[eid]!, Position.x[eid]!, alpha) * TILE_SIZE
      const y = lerp(Position.prevY[eid]!, Position.y[eid]!, alpha) * TILE_SIZE
      const cw = wTiles * TILE_SIZE
      const ch = hTiles * TILE_SIZE
      // Anchor the graphics by its footprint centre so the pop scales in place.
      g.pivot.set(cw / 2, ch / 2)
      g.position.set(x + cw / 2, y + ch / 2)

      // Pop-in: ease scale 0.55→1 and alpha 0→1 over SPAWN_MS.
      let spriteAlpha = 1
      const born = this.#spawnAnim.get(eid)
      if (born !== undefined) {
        const t = born + dt
        if (t >= SPAWN_MS) {
          this.#spawnAnim.delete(eid)
          g.scale.set(1)
        } else {
          this.#spawnAnim.set(eid, t)
          const p = t / SPAWN_MS
          const e = 1 - (1 - p) * (1 - p) // ease-out quad
          g.scale.set(0.55 + 0.45 * e)
          spriteAlpha = e
        }
      } else {
        g.scale.set(1)
      }
      g.alpha = spriteAlpha

      this.#updateIcon(eid, color, x, y, wTiles, hTiles, spr)
      const icon = this.#iconSprites.get(eid)
      if (icon) icon.alpha = spriteAlpha

      // Working pulse: ring the footprint of any entity content flagged active this tick.
      if (RenderHints.active[eid]) {
        this.#pulseLayer.roundRect(x + 1, y + 1, cw - 2, ch - 2, 4)
        anyPulse = true
      }
    }

    // One stroke for the whole batch — every ring shares the frame's pulse phase.
    if (anyPulse) {
      this.#pulseLayer.stroke({ width: 2, color: 0xffe08a, alpha: 0.25 + 0.5 * pulse })
    }

    // Entities whose sim entity vanished: hand them to the fade-out pool instead of destroying.
    for (const [eid, g] of this.#sprites) {
      if (!seen.has(eid)) {
        const icon = this.#iconSprites.get(eid) ?? null
        this.#iconSprites.delete(eid) // keep the sprite alive for the fade; drop it from the live map
        this.#dying.set(eid, { g, icon, t: 0 })
        this.#sprites.delete(eid)
        this.#spriteVals.delete(eid)
        this.#colorVals.delete(eid)
        this.#spawnAnim.delete(eid)
      }
    }

    // Advance the fade-out pool: shrink+fade in place, then destroy when done.
    for (const [eid, d] of this.#dying) {
      d.t += dt
      const p = d.t / REMOVE_MS
      if (p >= 1) {
        d.g.destroy()
        if (d.icon) d.icon.destroy()
        this.#dying.delete(eid)
        continue
      }
      const a = 1 - p
      d.g.scale.set(1 - 0.3 * p)
      d.g.alpha = a
      if (d.icon) d.icon.alpha = a
    }

    this.#drawMinimap(gw)
  }

  /**
   * Redraw the corner overview map from live entity positions: a translucent panel, every
   * (non-item) entity plotted as a dot in its own colour, and the current viewport as a "you are
   * here" rectangle. Read-only — like the rest of the renderer it never mutates the sim. The
   * panel geometry + world bounds are cached so a click can be mapped back to a world point
   * ({@link #minimapNav}). Skipped (and cleared) when {@link minimap} is off or the world is empty.
   */
  #drawMinimap(gw: GameWorld): void {
    const g = this.#minimapLayer
    g.clear()
    this.#minimapPanel = null
    this.#minimapWorld = null
    if (!this.minimap) return

    const { Position, Renderable } = gw.components
    const ents = renderableEntities(gw)
    // Pass 1: world-pixel bounds over the plotted set (skip transient belt items, shape 1).
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (let i = 0; i < ents.length; i++) {
      const eid = ents[i]!
      if (Renderable.sprite[eid]! >> 2 === 1) continue
      const x = Position.x[eid]! * TILE_SIZE
      const y = Position.y[eid]! * TILE_SIZE
      const w = Renderable.width[eid]! * TILE_SIZE
      const h = Renderable.height[eid]! * TILE_SIZE
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x + w > maxX) maxX = x + w
      if (y + h > maxY) maxY = y + h
    }
    if (!Number.isFinite(minX)) return

    const panel = minimapPanel(this.#app.screen.width, this.#app.screen.height, this.#minimapConfig)
    if (panel.w <= 0 || panel.h <= 0) return
    const world = padBounds({ minX, minY, maxX, maxY }, TILE_SIZE * 3)

    // Backdrop.
    g.roundRect(panel.x, panel.y, panel.w, panel.h, 4)
    g.fill({ color: 0x0b0d14, alpha: 0.72 })
    g.stroke({ width: 1, color: 0x3d4452, alpha: 0.9 })

    const { scale, contentX, contentY } = minimapFit(world, panel)
    const dot = Math.max(1.5, TILE_SIZE * scale)

    // Pass 2: plot each non-item entity as a small dot in its own colour.
    for (let i = 0; i < ents.length; i++) {
      const eid = ents[i]!
      if (Renderable.sprite[eid]! >> 2 === 1) continue
      const px = contentX + (Position.x[eid]! * TILE_SIZE - world.minX) * scale
      const py = contentY + (Position.y[eid]! * TILE_SIZE - world.minY) * scale
      g.rect(px, py, dot, dot)
      g.fill(Renderable.color[eid]!)
    }

    // The current viewport as a rectangle, clamped to the world bounds so it never leaves the panel.
    const vb = this.#camera.worldViewBounds()
    const vx0 = contentX + (Math.max(vb.minX, world.minX) - world.minX) * scale
    const vy0 = contentY + (Math.max(vb.minY, world.minY) - world.minY) * scale
    const vx1 = contentX + (Math.min(vb.maxX, world.maxX) - world.minX) * scale
    const vy1 = contentY + (Math.min(vb.maxY, world.maxY) - world.minY) * scale
    g.rect(vx0, vy0, Math.max(1, vx1 - vx0), Math.max(1, vy1 - vy0))
    g.stroke({ width: 1, color: 0xffffff, alpha: 0.85 })

    this.#minimapPanel = panel
    this.#minimapWorld = world
  }

  /**
   * If (clientX, clientY) falls on the minimap, glide the camera to the world point it maps to and
   * return true (so the caller suppresses the placement gesture). A pure view action — it drives
   * the same eased follow as the F key and never mutates the sim.
   */
  #minimapNav(clientX: number, clientY: number): boolean {
    const panel = this.#minimapPanel
    const world = this.#minimapWorld
    if (!this.minimap || !panel || !world) return false
    const rect = this.#app.canvas.getBoundingClientRect()
    const px = clientX - rect.left
    const py = clientY - rect.top
    if (!inMinimap(px, py, panel)) return false
    const point = minimapToWorld(px, py, world, panel)
    this.#camera.follow(() => point)
    return true
  }

  /**
   * Glide the camera to centre tile (x, y), the same eased follow the F key and minimap use. A pure
   * view action (never mutates the sim) — the app calls it to jump to an alert's source tile.
   */
  focusTile(x: number, y: number): void {
    const point = { x: (x + 0.5) * TILE_SIZE, y: (y + 0.5) * TILE_SIZE }
    this.#camera.follow(() => point)
  }

  /**
   * Register the per-entity overlay icons, keyed by an entity's packed `color`. Each colour
   * that maps to a texture has that texture drawn small in the top-right of every matching
   * entity's tile (the app uses this to stamp the build-bar glyph onto placed buildings).
   * Replacing the map updates existing entities on the next frame. The renderer draws the
   * textures but does not own them — the caller is responsible for their lifetime.
   */
  setIcons(icons: ReadonlyMap<number, Texture>): void {
    this.#iconTextures = icons
  }

  /**
   * Sync entity `eid`'s overlay icon: create/move/retexture it, or drop it if its colour has none.
   * A small item riding a belt (circle shape, `sprite >> 2 === 1`) gets its glyph centred on the
   * tile and sized to the item disc; a building/producer gets a larger glyph centred on its
   * footprint (over the recessed icon plate the body draws), so each machine type reads at a glance.
   */
  #updateIcon(
    eid: number,
    color: number,
    x: number,
    y: number,
    wTiles: number,
    hTiles: number,
    sprite: number,
  ): void {
    const tex = this.#iconTextures.get(color)
    if (!tex) {
      this.#removeIcon(eid)
      return
    }
    const fw = wTiles * TILE_SIZE
    const fh = hTiles * TILE_SIZE
    const isItem = sprite >> 2 === 1
    // Items sit on a single tile; buildings centre a bigger glyph on the whole footprint.
    const size = isItem ? TILE_SIZE * 0.42 : Math.min(fw, fh) * 0.4
    let icon = this.#iconSprites.get(eid)
    if (!icon) {
      icon = new Sprite(tex)
      icon.setSize(size, size)
      this.#iconSprites.set(eid, icon)
      this.#iconLayer.addChild(icon)
    } else if (icon.texture !== tex) {
      // A recycled entity id now hosts a different building/resource — swap glyph and resize.
      icon.texture = tex
      icon.setSize(size, size)
    }
    // Centre on the tile (items) or the footprint (buildings).
    const boxW = isItem ? TILE_SIZE : fw
    const boxH = isItem ? TILE_SIZE : fh
    icon.position.set(x + (boxW - size) / 2, y + (boxH - size) / 2)
  }

  /** Destroy entity `eid`'s overlay icon, if it has one. */
  #removeIcon(eid: number): void {
    const icon = this.#iconSprites.get(eid)
    if (icon) {
      icon.destroy()
      this.#iconSprites.delete(eid)
    }
  }

  /** Show (or clear, with `null`) the translucent placement preview. */
  setGhost(ghost: Ghost | null): void {
    const g = this.#ghostLayer
    g.clear()
    this.#ghostLabel.visible = false // hidden unless a line ghost sets a readout below
    if (!ghost) return
    if (ghost.kind === 'rect') {
      // A validity flag turns the ghost into a go/no-go signal: blocked placements fill red, clear
      // ones keep their build colour but gain a bold green ring. With no flag it's a plain tint.
      const invalid = ghost.valid === false
      const fillColor = invalid ? GHOST_INVALID : ghost.color
      const ringColor = ghost.valid === true ? GHOST_VALID : invalid ? GHOST_INVALID : ghost.color
      g.rect(ghost.x * TILE_SIZE, ghost.y * TILE_SIZE, ghost.w * TILE_SIZE, ghost.h * TILE_SIZE)
      g.fill({ color: fillColor, alpha: invalid ? 0.35 : 0.45 })
      g.stroke({ width: ghost.valid === undefined ? 2 : 3, color: ringColor, alpha: 0.95 })
      // A facing arrow for a directional placement (e.g. a port), so rotation reads on-screen.
      if (ghost.dir !== undefined) {
        const cx = (ghost.x + ghost.w / 2) * TILE_SIZE
        const cy = (ghost.y + ghost.h / 2) * TILE_SIZE
        this.#chevron(g, ghost.dir, cx, cy, TILE_SIZE * 0.34, 0xffffff, 0.95)
      }
      return
    }
    if (ghost.kind === 'cells') {
      // Multi-cell paste preview: a tinted footprint rect per captured object.
      for (let i = 0; i < ghost.cells.length; i++) {
        const c = ghost.cells[i]!
        g.rect(c.x * TILE_SIZE, c.y * TILE_SIZE, c.w * TILE_SIZE, c.h * TILE_SIZE)
        g.fill({ color: c.color, alpha: 0.4 })
        g.stroke({ width: 1.5, color: c.color, alpha: 0.85 })
        if (c.dir !== undefined) {
          const cx = (c.x + c.w / 2) * TILE_SIZE
          const cy = (c.y + c.h / 2) * TILE_SIZE
          this.#chevron(g, c.dir, cx, cy, TILE_SIZE * 0.3, 0xffffff, 0.9)
        }
      }
      return
    }
    // Line: a one-tile-thick band covering the bounding box of A..B — or, when a corner is given,
    // an L of two bands (A..corner then corner..B). Both bands are added to one path so the shared
    // corner tile fills once (no double-alpha).
    const band = (px: number, py: number, qx: number, qy: number): void => {
      g.rect(
        Math.min(px, qx) * TILE_SIZE,
        Math.min(py, qy) * TILE_SIZE,
        (Math.abs(qx - px) + 1) * TILE_SIZE,
        (Math.abs(qy - py) + 1) * TILE_SIZE,
      )
    }
    if (ghost.corner) {
      band(ghost.ax, ghost.ay, ghost.corner.x, ghost.corner.y)
      band(ghost.corner.x, ghost.corner.y, ghost.bx, ghost.by)
    } else {
      band(ghost.ax, ghost.ay, ghost.bx, ghost.by)
    }
    g.fill({ color: ghost.color, alpha: 0.45 })
    g.stroke({ width: 2, color: ghost.color, alpha: 0.9 })
    // Drag readout (e.g. "×5"): drawn just past the line's end tile so it tracks the cursor.
    if (ghost.label) {
      this.#ghostLabel.text = ghost.label
      this.#ghostLabel.anchor.set(0, 0.5)
      this.#ghostLabel.position.set((ghost.bx + 1) * TILE_SIZE + 4, (ghost.by + 0.5) * TILE_SIZE)
      this.#ghostLabel.visible = true
    }
  }

  /**
   * Show (or clear, with `null`) the status overlay: a tinted marker per flagged tile (e.g. starved
   * crafters, backed-up outputs), so the whole factory's trouble spots read at a glance. Drawn in
   * world space above entities. A pure read — the app supplies the marks from the read-only HUD
   * selectors; the renderer never mutates sim state.
   */
  setStatusOverlay(marks: readonly StatusMark[] | null): void {
    const g = this.#overlayLayer
    g.clear()
    if (!marks) return
    for (let i = 0; i < marks.length; i++) {
      const m = marks[i]!
      const w = (m.w ?? 1) * TILE_SIZE
      const h = (m.h ?? 1) * TILE_SIZE
      g.rect(m.x * TILE_SIZE, m.y * TILE_SIZE, w, h)
      g.fill({ color: m.color, alpha: 0.28 })
      g.stroke({ width: 2, color: m.color, alpha: 0.95 })
    }
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
    this.#iconSprites.clear()
    this.#dying.clear()
    this.#spawnAnim.clear()
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
        // Belt track: a soft tile backdrop with the big SVG flow-arrow sign on top.
        const inner = TILE_SIZE - pad * 2
        // Base tile, gently rounded and low-contrast so it reads as a backdrop, not a wall.
        g.roundRect(pad, pad, inner, inner, 4)
        g.fill({ color, alpha: 0.22 })
        // A chunky, near-full-tile arrow pointing along travel.
        this.#beltArrow(g, orient)
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
      case 6: {
        // Flat ground fill: the whole tile, edge to edge, at a soft alpha so it reads as a
        // background layer that belts and buildings sit on top of (content uses it for terrain).
        g.rect(0, 0, wTiles * TILE_SIZE, hTiles * TILE_SIZE)
        g.fill({ color, alpha: 0.55 })
        g.stroke({ width: 1, color: 0x000000, alpha: 0.08 })
        return
      }
      // Buildings — a framed panel wearing a kind-specific silhouette cap. The specific machine is
      // identified by its centred icon; the cap distinguishes the broad category at a glance.
      case 7:
        this.#paintBuilding(g, color, wTiles, hTiles, CAP_DRILL) // extractor
        return
      case 8:
        this.#paintBuilding(g, color, wTiles, hTiles, CAP_DOME) // lab
        return
      case 9:
        this.#paintBuilding(g, color, wTiles, hTiles, CAP_ROOF) // depot / store
        return
      case 10:
        this.#paintBuilding(g, color, wTiles, hTiles, CAP_STACKS) // raw producer
        return
      default: {
        // Plain building / crafter / scenery (shapes 0 and 5): the framed panel, no cap.
        this.#paintBuilding(g, color, wTiles, hTiles, CAP_NONE)
      }
    }
  }

  /**
   * Paint a building glyph: a framed panel derived entirely from the entity's single colour — a
   * soft drop shadow, a darker bezel, a lit face with a top highlight (fakes a top-down light), and
   * a recessed icon plate the centred glyph sits on — then an optional `cap` silhouette on top so
   * the structure's kind reads at a glance. No art assets; the engine stays game-agnostic.
   */
  #paintBuilding(g: Graphics, color: number, wTiles: number, hTiles: number, cap: number): void {
    const fw = wTiles * TILE_SIZE
    const fh = hTiles * TILE_SIZE
    const r = 5
    // Drop shadow, offset down-right.
    g.roundRect(3, 4, fw - 4, fh - 4, r)
    g.fill({ color: 0x000000, alpha: 0.25 })
    // Bezel/frame: full footprint in a darkened shade.
    g.roundRect(1, 1, fw - 2, fh - 2, r)
    g.fill(shade(color, -0.35))
    // Face: inset panel in the base colour.
    const fi = 3
    g.roundRect(fi, fi, fw - fi * 2, fh - fi * 2, r - 1)
    g.fill(color)
    // Top highlight band (fake top-down light).
    g.roundRect(fi + 1, fi + 1, fw - fi * 2 - 2, (fh - fi * 2) * 0.4, r - 2)
    g.fill({ color: shade(color, 0.22), alpha: 0.55 })
    // Recessed icon plate: a soft dark rounded square so the white glyph reads on any colour.
    const ps = Math.min(fw, fh) * 0.52
    g.roundRect((fw - ps) / 2, (fh - ps) / 2, ps, ps, 4)
    g.fill({ color: shade(color, -0.55), alpha: 0.45 })
    if (cap !== CAP_NONE) this.#buildingCap(g, color, fw, cap)
    // Crisp rim on the bezel edge.
    g.roundRect(1, 1, fw - 2, fh - 2, r)
    g.stroke({ width: 1, color: shade(color, 0.3), alpha: 0.6 })
  }

  /**
   * Draw a building's category `cap` — a small silhouette motif in the top strip of the panel,
   * above the icon plate. All are derived from the base colour (a lighter shade + a dark outline)
   * so they read on any hue: a drill wedge (extractor), a dome (lab), a gabled roof (depot), or
   * twin stacks (producer). `fw` is the footprint width in px; the cap is centred on it.
   */
  #buildingCap(g: Graphics, color: number, fw: number, cap: number): void {
    const cx = fw / 2
    const light = shade(color, 0.42)
    const dark = shade(color, -0.5)
    if (cap === CAP_DRILL) {
      // Downward wedge biting toward the machine.
      const w = TILE_SIZE * 0.22
      g.poly([cx - w, 5, cx + w, 5, cx, 5 + w * 1.3])
      g.fill({ color: light, alpha: 0.9 })
      g.stroke({ width: 1, color: dark, alpha: 0.5 })
    } else if (cap === CAP_DOME) {
      // Rounded observatory cap.
      const rr = TILE_SIZE * 0.2
      g.arc(cx, 8, rr, Math.PI, 0)
      g.fill({ color: light, alpha: 0.9 })
      g.stroke({ width: 1, color: dark, alpha: 0.5 })
    } else if (cap === CAP_ROOF) {
      // Gabled warehouse roofline.
      const w = TILE_SIZE * 0.28
      g.poly([cx - w, 9, cx, 4, cx + w, 9])
      g.fill({ color: light, alpha: 0.9 })
      g.stroke({ width: 1, color: dark, alpha: 0.5 })
    } else if (cap === CAP_STACKS) {
      // Twin chimneys.
      const s = TILE_SIZE * 0.09
      const gap = TILE_SIZE * 0.16
      for (const sx of [-gap, gap]) {
        g.roundRect(cx + sx - s / 2, 4, s, TILE_SIZE * 0.22, 1)
        g.fill({ color: dark, alpha: 0.85 })
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

  /**
   * Draw the belt flow-arrow sign ({@link BELT_ARROW}) centred on the tile, scaled to the tile and
   * rotated to point along travel for `orient` (0=N,1=E,2=S,3=W). Each authored `[forward, lateral]`
   * point maps onto the travel axis `(ux,uy)` and its perpendicular `(px,py)`, in tile-local pixels
   * — so the sign rides the entity's own graphics and lands on its tile. Filled white at half alpha.
   */
  #beltArrow(g: Graphics, orient: number): void {
    const c = TILE_SIZE / 2
    const ux = orient === 1 ? 1 : orient === 3 ? -1 : 0
    const uy = orient === 0 ? -1 : orient === 2 ? 1 : 0
    const px = -uy
    const py = ux
    const pts: number[] = []
    for (let i = 0; i < BELT_ARROW.length; i++) {
      const f = BELT_ARROW[i]![0] * TILE_SIZE
      const l = BELT_ARROW[i]![1] * TILE_SIZE
      pts.push(c + ux * f + px * l, c + uy * f + py * l)
    }
    g.poly(pts)
    g.fill({ color: 0xffffff, alpha: 0.5 })
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
    // A press that began on the minimap drives camera navigation, not a placement gesture.
    let minimapPanning = false

    const tileAt = (clientX: number, clientY: number): GridCoord => {
      const rect = canvas.getBoundingClientRect()
      return this.#camera.screenToTile(clientX - rect.left, clientY - rect.top, TILE_SIZE)
    }

    // The pointer now drives placement only — panning is on the keyboard (WASD). A
    // press starts a gesture, moves update it, and release ends it.
    canvas.addEventListener('pointerdown', (e) => {
      // Only the left button drives placement gestures; the right button cancels (below).
      if (e.button !== 0) return
      // A click on the minimap glides the camera there instead of placing.
      if (this.#minimapNav(e.clientX, e.clientY)) {
        minimapPanning = true
        return
      }
      pressed = true
      if (this.onDragStart) this.onDragStart(tileAt(e.clientX, e.clientY))
    })
    // Right-click cancels the armed tool/gesture; suppress the native context menu.
    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      if (this.onCancel) this.onCancel()
    })
    globalThis.addEventListener('pointerup', (e) => {
      if (minimapPanning) {
        minimapPanning = false
        return
      }
      if (pressed && this.onDragEnd) this.onDragEnd(tileAt(e.clientX, e.clientY), e.shiftKey)
      pressed = false
    })
    globalThis.addEventListener('pointermove', (e) => {
      this.#lastClientX = e.clientX
      this.#lastClientY = e.clientY
      // Dragging on the minimap keeps re-aiming the camera; skip placement/hover.
      if (minimapPanning) {
        this.#minimapNav(e.clientX, e.clientY)
        return
      }
      const tile = tileAt(e.clientX, e.clientY)
      if (pressed && this.onDragMove) this.onDragMove(tile, e.shiftKey)
      if (this.onTileHover) this.onTileHover(tile)
    })
    // Track whether the cursor is over the canvas so edge panning only kicks in on screen.
    canvas.addEventListener('pointerenter', () => (this.#pointerInside = true))
    canvas.addEventListener('pointerleave', () => (this.#pointerInside = false))
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault()
        // Let the app claim the wheel first (e.g. rotate an armed port instead of zooming). It
        // returns true when it handled the scroll; otherwise fall through to camera zoom.
        if (this.onWheel?.(e.deltaY)) return
        const rect = canvas.getBoundingClientRect()
        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1
        this.#camera.zoomTo(e.clientX - rect.left, e.clientY - rect.top, factor)
      },
      { passive: false },
    )

    // R rotates the armed placement (e.g. a port's arrow); Q picks the tool under the cursor
    // ("pipette"); F smoothly re-centers the camera on the tile under the cursor (a follow that
    // glides in and settles, released by any manual pan). The app owns the resulting state; the
    // renderer just relays the keypress (it never mutates sim state). Q/F resolve the tile from
    // the last pointer position. All ignore keystrokes aimed at a text field so typing a
    // save/blueprint name isn't hijacked.
    globalThis.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
      const k = e.key.toLowerCase()
      if (k === 'r' && this.onRotate) this.onRotate()
      else if (k === 'q' && this.onPick)
        this.onPick(tileAt(this.#lastClientX, this.#lastClientY), e.shiftKey)
      else if (k === 'f') {
        const tile = tileAt(this.#lastClientX, this.#lastClientY)
        // Glide to the tile centre; a constant target eases in and settles at the viewport centre.
        const point = { x: (tile.x + 0.5) * TILE_SIZE, y: (tile.y + 0.5) * TILE_SIZE }
        this.#camera.follow(() => point)
      }
    })

    this.#installCameraDrive()
  }

  /**
   * Drive the camera each frame off the Pixi ticker: integrate held WASD keys and edge-of-screen
   * pointer position into a pan (screen px/sec, so it's frame-rate independent), then advance the
   * camera's own zoom/follow smoothing. Panning input releases any active follow via `panBy`.
   */
  #installCameraDrive(): void {
    const PAN_PX_PER_SEC = 700
    const EDGE_MARGIN = 28
    const PAN_KEYS = new Set(['w', 'a', 's', 'd'])
    const held = new Set<string>()

    globalThis.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
      const k = e.key.toLowerCase()
      if (PAN_KEYS.has(k)) held.add(k)
    })
    globalThis.addEventListener('keyup', (e) => held.delete(e.key.toLowerCase()))
    // A key released while the window is unfocused never fires keyup; clear to be safe.
    globalThis.addEventListener('blur', () => held.clear())

    this.#app.ticker.add((ticker) => {
      const dtMs = ticker.deltaMS
      const step = PAN_PX_PER_SEC * (dtMs / 1000)
      let dx = 0
      let dy = 0
      if (held.has('a')) dx += step
      if (held.has('d')) dx -= step
      if (held.has('w')) dy += step
      if (held.has('s')) dy -= step

      // Edge scroll: pan when the on-screen cursor sits within a margin of a canvas edge. The
      // strength ramps from 0 at the margin to full at the very edge so it eases in.
      if (this.edgeScroll && this.#pointerInside) {
        const rect = this.#app.canvas.getBoundingClientRect()
        const px = this.#lastClientX - rect.left
        const py = this.#lastClientY - rect.top
        if (px >= 0 && px <= rect.width && py >= 0 && py <= rect.height) {
          if (px < EDGE_MARGIN) dx += step * (1 - px / EDGE_MARGIN)
          else if (px > rect.width - EDGE_MARGIN) dx -= step * (1 - (rect.width - px) / EDGE_MARGIN)
          if (py < EDGE_MARGIN) dy += step * (1 - py / EDGE_MARGIN)
          else if (py > rect.height - EDGE_MARGIN)
            dy -= step * (1 - (rect.height - py) / EDGE_MARGIN)
        }
      }

      if (dx !== 0 || dy !== 0) this.#camera.panBy(dx, dy)
      this.#camera.setViewport(this.#app.screen.width, this.#app.screen.height)
      this.#camera.update(dtMs)
    })
  }
}
