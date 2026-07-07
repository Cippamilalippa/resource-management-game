import type { GameWorld } from '@factory/engine/core'
import type { Renderer } from '@factory/engine/render'
import type { GridCoord } from '@factory/shared'
import {
  enqueuePlaceBuilding,
  enqueuePlaceBelt,
  enqueuePlacePort,
  enqueuePlaceCrafter,
  enqueuePlaceSplitter,
  enqueueSetPortFilter,
  enqueueRemove,
  dispatchCommand,
  canAfford,
  projectBelt,
  projectBeltPath,
  terrainTypeOf,
  terrainTypeAt,
  buildingAt,
  tileKey,
  KIND_OUTPUT,
  KIND_INPUT,
  KIND_SPLITTER,
  MAX_PORT_FILTER,
  FILTER_EMPTY,
  type GameState,
} from './gameLogic.ts'
import { buildStore, type BuildItem } from './buildStore.ts'
import { historyStore, type HistoryCommand } from './historyStore.ts'
import { sfx } from './sfx.ts'
import { blueprintStore } from './blueprintStore.ts'
import {
  captureBlueprint,
  blueprintPlacements,
  blueprintGhostCells,
  normalizeRect,
  type Blueprint,
  type Placement,
} from './blueprint.ts'
import { resolveInspect, type InspectInfo, type InspectRegistry } from './inspect.ts'
import { inspectStore } from './inspectStore.ts'
import { recipeStore } from './recipeStore.ts'
import { filterStore } from './filterStore.ts'
import { utilizationStore } from './utilizationStore.ts'
import type { MachineIndex, RecipeChoice } from './machines.ts'

/** Whether two footprints describe the same object (same anchor and size). */
function sameFootprint(a: InspectInfo['footprint'], b: InspectInfo['footprint']): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h
}

/**
 * Wire the renderer's pointer gestures to two modes that switch on whether a build tool is
 * armed:
 *
 * - **Build mode** (a tool selected): a building places on a single click; a belt is drawn
 *   by dragging start→end. Gestures only enqueue commands the sim applies next tick —
 *   nothing here writes sim state, preserving determinism and the render-is-read-only rule.
 * - **Inspect mode** (no tool): hovering highlights the object's full footprint and shows
 *   its info in the sidebar; clicking it pins the sidebar (clicking it again, or empty
 *   ground, unpins). Inspection is purely a read of sim state.
 *
 * Returns a `refresh()` the render loop calls on its throttle so a pinned/hovered object's
 * live numbers (carried item, storage…) stay current.
 */
export function installPlacement(
  renderer: Renderer,
  world: GameWorld,
  state: GameState,
  registry: InspectRegistry,
  machines: MachineIndex,
): { refresh: () => void } {
  const grid = state.grid

  /** One resource cost line the sim charges/refunds: a resource colour and a unit amount. */
  type Cost = readonly { readonly color: number; readonly amount: number }[]

  /** Scale a per-unit cost by `n` (a belt run length), or undefined when there's nothing to charge. */
  const scaleCost = (cost: Cost | undefined, n: number): Cost | undefined =>
    cost && cost.length > 0
      ? cost.map((c) => ({ color: c.color, amount: c.amount * n }))
      : undefined

  /**
   * The build cost the palette assigns to a footprint colour. Used where placement/removal works
   * from a placed object's colour rather than a live tool selection — the delete-refund and the
   * blueprint-paste paths — so a pasted or removed object is charged/refunded the same as one
   * placed directly.
   */
  const costForColor = (color: number): Cost | undefined => {
    for (const it of buildStore.get().items) {
      if (it.color === color && it.cost && it.cost.length > 0) return it.cost
    }
    return undefined
  }

  /** The per-cadence credit upkeep the palette assigns to a footprint colour (0 = free to run). */
  const upkeepForColor = (color: number): number => {
    for (const it of buildStore.get().items) {
      if (it.color === color && it.upkeep && it.upkeep > 0) return it.upkeep
    }
    return 0
  }

  /** The colour of whatever deletable object sits at (x, y), for looking up its refund. */
  const colorAt = (x: number, y: number): number | null => {
    const info = resolveInspect(
      world,
      grid,
      state.buildings,
      state.villages,
      state.deposits,
      registry,
      x,
      y,
    )
    return info ? info.color : null
  }

  // Undo/redo replays and reverses recorded gestures through the ordinary command queue, so the
  // sim only ever sees regular place/remove commands and determinism is untouched. Reset history
  // here: a fresh placement install means a fresh session, so any stale inverses must be dropped.
  historyStore.setDispatch((cmd) => dispatchCommand(world, cmd))
  historyStore.reset()

  /** One placement within a gesture: the command that (re)creates it and the tiles it fills. */
  interface PlacedStep {
    readonly cmd: HistoryCommand
    readonly tiles: readonly { readonly x: number; readonly y: number }[]
    /** Build cost charged, so undo can refund the same amount it spent (absent when free). */
    readonly refund?: Cost | undefined
  }

  /**
   * Record a completed build gesture as one undoable step. Replaying re-sends each placement's
   * command; undoing removes every filled tile in reverse placement order, crediting each
   * placement's refund on its first tile so the treasury nets out across an undo/redo cycle.
   */
  const recordGesture = (label: string, steps: readonly PlacedStep[]): void => {
    if (steps.length === 0) return
    const redo: HistoryCommand[] = steps.map((s) => s.cmd)
    const undo: HistoryCommand[] = []
    for (let i = steps.length - 1; i >= 0; i--) {
      const s = steps[i]!
      for (let j = 0; j < s.tiles.length; j++) {
        const t = s.tiles[j]!
        undo.push({
          type: 'remove',
          x: t.x,
          y: t.y,
          ...(j === 0 && s.refund && s.refund.length > 0 ? { refund: s.refund } : {}),
        })
      }
    }
    historyStore.push({ label, undo, redo })
    sfx.play('place') // one placement blip per completed gesture (single, line-stamp, or paste)
  }

  /**
   * Resolve an absolute {@link Placement} (from a captured blueprint) to its place command, the tiles
   * it fills, and the palette cost charged — the shared bridge behind both blueprint paste and
   * delete-undo (re-placing what was removed). The command shape matches the `place_*` commands
   * exactly, so replaying it is identical to an original placement.
   */
  const placementToStep = (p: Placement): PlacedStep => {
    const cost = costForColor(p.color)
    switch (p.kind) {
      case 'belt': {
        const run = projectBelt(p.ax, p.ay, p.bx, p.by)
        const beltCost = scaleCost(cost, run.length)
        const tiles: { x: number; y: number }[] = []
        for (let i = 0; i < run.length; i++)
          tiles.push({ x: p.ax + run.dx * i, y: p.ay + run.dy * i })
        return {
          cmd: {
            type: 'place_belt',
            ax: p.ax,
            ay: p.ay,
            bx: p.bx,
            by: p.by,
            color: p.color,
            moveEvery: p.moveEvery,
            face: p.face,
            ...(beltCost ? { cost: beltCost } : {}),
          },
          tiles,
          refund: beltCost,
        }
      }
      case 'port':
        return {
          cmd: {
            type: 'place_port',
            x: p.x,
            y: p.y,
            port: p.port,
            color: p.color,
            spawnEvery: p.spawnEvery,
            dir: p.dir,
            ...(cost ? { cost } : {}),
          },
          tiles: [{ x: p.x, y: p.y }],
          refund: cost,
        }
      case 'splitter':
        return {
          cmd: {
            type: 'place_splitter',
            x: p.x,
            y: p.y,
            color: p.color,
            ...(cost ? { cost } : {}),
          },
          tiles: [{ x: p.x, y: p.y }],
          refund: cost,
        }
      case 'building': {
        const upkeep = upkeepForColor(p.color)
        return {
          cmd: {
            type: 'place_building',
            x: p.x,
            y: p.y,
            w: p.w,
            h: p.h,
            color: p.color,
            accepts: p.accepts,
            ...(p.researchLab ? { researchLab: true } : {}),
            ...(cost ? { cost } : {}),
            ...(upkeep > 0 ? { upkeep } : {}),
          },
          tiles: [{ x: p.x, y: p.y }],
          refund: cost,
        }
      }
      case 'crafter': {
        const upkeep = upkeepForColor(p.color)
        return {
          cmd: {
            type: 'place_crafter',
            x: p.x,
            y: p.y,
            w: p.w,
            h: p.h,
            color: p.color,
            craftEvery: p.craftEvery,
            storageCap: p.storageCap,
            ...(p.recipe ? { recipe: p.recipe, inputs: p.inputs, outputs: p.outputs } : {}),
            ...(cost ? { cost } : {}),
            ...(upkeep > 0 ? { upkeep } : {}),
          },
          tiles: [{ x: p.x, y: p.y }],
          refund: cost,
        }
      }
    }
  }

  /**
   * Record a completed *delete* gesture as one undoable step — the mirror of {@link recordGesture}.
   * `steps` are the captured objects that were removed; undoing re-places them (charging their cost
   * again) and redoing removes them (refunding), so the treasury nets out across the cycle. Needs no
   * sim change: undo replays ordinary `place_*` commands, redo ordinary `remove`s.
   */
  const recordDeletion = (label: string, steps: readonly PlacedStep[]): void => {
    if (steps.length === 0) return
    const undo: HistoryCommand[] = steps.map((s) => s.cmd)
    const redo: HistoryCommand[] = []
    for (const s of steps) {
      for (let j = 0; j < s.tiles.length; j++) {
        const t = s.tiles[j]!
        redo.push({
          type: 'remove',
          x: t.x,
          y: t.y,
          ...(j === 0 && s.refund && s.refund.length > 0 ? { refund: s.refund } : {}),
        })
      }
    }
    historyStore.push({ label, undo, redo })
  }

  /** Capture the objects inside `rect` as re-placeable steps (read-only), for delete-undo. */
  const captureRegionSteps = (rect: {
    x0: number
    y0: number
    x1: number
    y1: number
  }): PlacedStep[] => {
    const bp = captureBlueprint(state, world, registry, rect)
    return blueprintPlacements(bp, rect.x0, rect.y0).map(placementToStep)
  }

  /**
   * Tiles along the axis-projected drag start→end, stepping by `step` (a footprint size) so stamped
   * machines sit flush without overlapping. A zero-length drag yields just the start tile. Used to
   * line-stamp a row of ports (step 1) or machines (step = footprint) in one gesture.
   */
  const lineTiles = (start: GridCoord, end: GridCoord, step: number): GridCoord[] => {
    const { dx, dy, length } = projectBelt(start.x, start.y, end.x, end.y)
    const out: GridCoord[] = []
    for (let i = 0; i < length; i += Math.max(1, step))
      out.push({ x: start.x + dx * i, y: start.y + dy * i })
    return out
  }

  /** Remove whatever deletable object sits at (x, y), refunding its build cost (config-scaled by
   * the sim). A no-op tile enqueues nothing. Shared by the single-click and marquee delete paths. */
  const removeTile = (x: number, y: number): void => {
    const color = colorAt(x, y)
    const refund = color === null ? undefined : costForColor(color)
    enqueueRemove(world, { x, y, ...(refund ? { refund } : {}) })
  }

  // The recipe picker (sidebar) drives recipe changes on the pinned crafter through here — only the
  // host owns the world, so the store just carries intent and this enqueues the command. The change
  // is undoable: we capture the crafter's current recipe first and record it as the inverse.
  recipeStore.setController({
    choose: (recipe: RecipeChoice) => {
      const sel = recipeStore.get()
      if (!sel) return
      const setRecipeCmd = (r: RecipeChoice): HistoryCommand => ({
        type: 'set_recipe',
        x: sel.x,
        y: sel.y,
        recipe: r.int,
        inputs: r.inputs,
        outputs: r.outputs,
        craftEvery: r.craftEvery,
        storageCap: r.storageCap,
      })
      // Read the crafter's current recipe so a known previous recipe can be restored on undo.
      const b = buildingAt(state.buildings, sel.x, sel.y)
      const prev = b >= 0 ? machines.recipeByInt.get(state.buildings.recipe[b]!) : undefined
      dispatchCommand(world, setRecipeCmd(recipe))
      // Only a change between two known recipes is recorded (an empty→first assignment has no clean
      // inverse command, so it is left out rather than faked).
      if (prev && prev.int !== recipe.int) {
        historyStore.push({
          label: 'Recipe',
          undo: [setRecipeCmd(prev)],
          redo: [setRecipeCmd(recipe)],
        })
      }
    },
  })

  // The port-filter editor (sidebar) drives colour-filter changes on the pinned port through here.
  filterStore.setController({
    set: (mode, colors) => {
      const sel = filterStore.get()
      if (!sel) return
      enqueueSetPortFilter(world, { x: sel.x, y: sel.y, mode, colors: [...colors] })
    },
  })

  /**
   * Publish (or clear) the recipe picker for the object described by `info`. A crafter (a building
   * whose footprint colour maps to a {@link MachineDef}) exposes its recipe options; an extraction
   * machine's options are filtered to the recipe matching the terrain it sits on. Anything else
   * clears the picker.
   */
  const publishRecipe = (info: InspectInfo | null): void => {
    if (!info) {
      recipeStore.set(null)
      return
    }
    const { x, y } = info.footprint
    const b = buildingAt(state.buildings, x, y)
    const def = b >= 0 ? machines.byColor.get(info.color) : undefined
    if (b < 0 || !def || !state.buildings.crafts[b]) {
      recipeStore.set(null)
      return
    }
    const options = def.extraction
      ? def.recipes.filter((r) => r.requiresTerrainType === terrainTypeAt(state.terrain, x, y))
      : def.recipes
    recipeStore.set({
      x,
      y,
      machineName: def.name,
      extraction: def.extraction,
      currentInt: state.buildings.recipe[b]!,
      options,
    })
  }

  /**
   * Publish (or clear) the port colour-filter editor for `info`. A pinned input/output port exposes
   * its live filter (mode + colours); anything else clears the editor. Read-only — the actual change
   * flows through the wired controller as a `set_port_filter` command.
   */
  const publishFilter = (info: InspectInfo | null): void => {
    const t = info ? grid.index.get(tileKey(info.footprint.x, info.footprint.y)) : undefined
    if (t === undefined) {
      filterStore.set(null)
      return
    }
    const kind = grid.kind[t]!
    if (kind !== KIND_OUTPUT && kind !== KIND_INPUT) {
      filterStore.set(null)
      return
    }
    const colors: number[] = []
    for (let j = 0; j < MAX_PORT_FILTER; j++) {
      const c = grid.filterColor[t * MAX_PORT_FILTER + j]!
      if (c !== FILTER_EMPTY) colors.push(c)
    }
    filterStore.set({
      x: info!.footprint.x,
      y: info!.footprint.y,
      port: kind === KIND_OUTPUT ? 'output' : 'input',
      mode: grid.filterMode[t]!,
      colors,
    })
  }
  // Ghost tint for a placement the sim would reject (off-belt or wrong terrain), and the
  // tint the delete tool paints the object it would remove. A muted rose, matching the
  // renderer's softened ghost palette so the cue reads without a harsh neon glare.
  const INVALID_COLOR = 0xd98c8c

  /**
   * The footprint of the deletable object at (x, y) — a 1×1 belt-grid tile, or a resource
   * building's full footprint — or null when nothing there can be removed (terrain, plain
   * scenery, or empty ground). Mirrors the sim's `remove` gate so the delete ghost agrees
   * with what placement would actually delete.
   */
  const deletableAt = (x: number, y: number): InspectInfo['footprint'] | null => {
    if (grid.index.has(tileKey(x, y))) return { x, y, w: 1, h: 1 }
    const b = buildingAt(state.buildings, x, y)
    if (b < 0) return null
    return {
      x: state.buildings.bx[b]!,
      y: state.buildings.by[b]!,
      w: state.buildings.bw[b]!,
      h: state.buildings.bh[b]!,
    }
  }

  /**
   * Whether the w×h footprint anchored at (x, y) is clear for a building/crafter: no belt-grid tile
   * (belt/port/splitter) and no other building on any covered tile. Mirrors the sim's
   * {@link footprintClear} gate so the ghost's red "blocked" preview matches what placement rejects.
   */
  const footprintClear = (x: number, y: number, w: number, h: number): boolean => {
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        const tx = x + dx
        const ty = y + dy
        if (grid.index.has(tileKey(tx, ty))) return false
        if (buildingAt(state.buildings, tx, ty) >= 0) return false
      }
    }
    return true
  }

  /**
   * Whether a producer tool could legally drop on the tile (x, y): its footprint must be clear
   * (no overlap with a belt or another building) and, if it declares `requiresTerrain`, its anchor
   * must sit on the matching ground. Mirrors the sim's `place_crafter` gate so the ghost agrees.
   */
  const producerValid = (item: BuildItem, x: number, y: number): boolean => {
    if (!footprintClear(x, y, item.w, item.h)) return false
    // An extraction machine (mine/derrick) auto-adopts the recipe of the terrain it lands on, so it
    // is only "clear to place" over a deposit one of its recipes can mine — off a deposit it would
    // sit idle, so the ghost reads blocked to match what actually happens on placement.
    const def = machines.byColor.get(item.color)
    if (def?.extraction) {
      const terrain = terrainTypeAt(state.terrain, x, y)
      return def.recipes.some((r) => r.requiresTerrainType === terrain)
    }
    if (!item.requiresTerrain) return true
    return terrainTypeAt(state.terrain, x, y) === terrainTypeOf(item.requiresTerrain)
  }

  /** Whether a plain building/store/depot could legally drop at (x, y): its footprint must be clear. */
  const buildingValid = (item: BuildItem, x: number, y: number): boolean =>
    footprintClear(x, y, item.w, item.h)

  /** Whether a splitter could legally drop at (x, y): like a port, it must sit on a belt tile. */
  const splitterValid = (x: number, y: number): boolean => grid.index.has(tileKey(x, y))

  // Unit steps per direction index (0=N,1=E,2=S,3=W) and the opposite of a direction.
  const PORT_DX = [0, 1, 0, -1] as const
  const PORT_DY = [-1, 0, 1, 0] as const
  const opposite = (d: number): number => (d + 2) & 3

  // The facing the next port places with, cycled by R. Buildings/belts/splitters take their
  // orientation from their footprint or drag, so rotation only changes a port's arrow.
  let placeDir = 1 // East

  /** The direction from a port at facing `placeDir` to the building it would bridge. */
  const portBuildingDir = (port: 'input' | 'output'): number =>
    port === 'output' ? opposite(placeDir) : placeDir

  /**
   * Whether a port tool could legally drop on the tile (x, y): it must sit on a belt tile, and
   * the building it designates by its arrow must border it — an output's arrow points away from
   * the building it drains, an input's toward the building it feeds. Mirrors the sim's
   * `place_port` link step so the ghost previews red where the port would have nothing to link to.
   */
  const portValid = (port: 'input' | 'output', x: number, y: number): boolean => {
    if (!grid.index.has(tileKey(x, y))) return false
    const d = portBuildingDir(port)
    return buildingAt(state.buildings, x + PORT_DX[d]!, y + PORT_DY[d]!) >= 0
  }

  // The belt's start tile while a drag is in progress (belts only); null otherwise.
  let beltStart: GridCoord | null = null
  // The tile the pointer was pressed on, to tell a click (press==release) from a drag.
  let pressTile: GridCoord | null = null
  // Config pipette (Shift+Q): the recipe copied off a crafter, applied to matching machines placed
  // next so a row of identical smelters can be laid down in one pass. Cleared by a plain pick.
  let pendingRecipe: { color: number; recipe: RecipeChoice } | null = null
  // Inspect-mode state: the last hovered tile, and the pinned object (tile + footprint), if any.
  let hoverTile: GridCoord | null = null
  let pinned: { tile: GridCoord; footprint: InspectInfo['footprint'] } | null = null
  // Clipboard-mode state: the last tile the cursor was over (so a mode switch can redraw the paste
  // ghost without a fresh pointer event), and the copy-select drag's start corner while dragging.
  let cursorTile: GridCoord | null = null
  let selectStart: GridCoord | null = null

  /** Sample whether `info`'s crafter fired this refresh into the rolling utilization window,
   * keyed by its footprint tile (see `utilizationStore.ts`). A no-op for anything that isn't a
   * crafter. Reads `RenderHints.active` — the same transient sim→render pulse the renderer uses
   * to animate a working machine — so this is a read, never a write, of sim/render state. */
  const sampleUtilization = (info: InspectInfo | null): void => {
    if (!info) return
    const { x, y } = info.footprint
    const b = buildingAt(state.buildings, x, y)
    if (b < 0 || !state.buildings.crafts[b]) return
    const active = world.components.RenderHints.active[state.buildings.eid[b]!] === 1
    utilizationStore.sample(tileKey(x, y), active)
  }

  /** Push the current inspect view (pinned wins over hover) to the store and highlight. `sample`
   * is true only on the render loop's throttled refresh (never on a raw hover/click), so the
   * utilization window advances on a steady wall-clock cadence rather than per pointer event. */
  const applyView = (sample = false): void => {
    if (pinned) {
      const info = resolveInspect(
        world,
        grid,
        state.buildings,
        state.villages,
        state.deposits,
        registry,
        pinned.tile.x,
        pinned.tile.y,
        utilizationStore.utilization,
      )
      if (info) {
        inspectStore.set({ info, pinned: true })
        renderer.setHighlight({ ...info.footprint, color: info.color, selected: true })
        publishRecipe(info) // recipe picker follows the pinned crafter
        publishFilter(info) // filter editor follows the pinned port
        if (sample) sampleUtilization(info)
        return
      }
      pinned = null // the pinned object vanished — fall through to hover.
    }
    const info = hoverTile
      ? resolveInspect(
          world,
          grid,
          state.buildings,
          state.villages,
          state.deposits,
          registry,
          hoverTile.x,
          hoverTile.y,
          utilizationStore.utilization,
        )
      : null
    inspectStore.set({ info, pinned: false })
    renderer.setHighlight(info ? { ...info.footprint, color: info.color, selected: false } : null)
    publishRecipe(null) // nothing pinned → no recipe picker
    publishFilter(null) // nothing pinned → no filter editor
    if (sample) sampleUtilization(info)
  }

  /** Clear all inspect state (entering build mode, or nothing under the cursor). */
  const clearInspect = (): void => {
    pinned = null
    hoverTile = null
    inspectStore.set({ info: null, pinned: false })
    renderer.setHighlight(null)
    recipeStore.set(null)
    filterStore.set(null)
  }

  /** A click in inspect mode: pin the object under the cursor, or unpin (toggle / empty). */
  const inspectClick = (tile: GridCoord): void => {
    const info = resolveInspect(
      world,
      grid,
      state.buildings,
      state.villages,
      state.deposits,
      registry,
      tile.x,
      tile.y,
    )
    if (!info) {
      pinned = null
    } else if (pinned && sameFootprint(pinned.footprint, info.footprint)) {
      pinned = null
    } else {
      pinned = { tile: { x: tile.x, y: tile.y }, footprint: info.footprint }
    }
    applyView()
  }

  // The tile the build ghost was last drawn on, so a rotation (R) can redraw it in place.
  let ghostTile: GridCoord | null = null

  /** Draw the placement ghost for the armed tool at `tile` (build mode only). */
  const previewGhost = (item: BuildItem, tile: GridCoord): void => {
    ghostTile = { x: tile.x, y: tile.y }
    // Buildings, ports, splitters and producers all place on a single tile — preview a footprint rect.
    if (
      item.kind === 'building' ||
      item.kind === 'port' ||
      item.kind === 'splitter' ||
      item.kind === 'producer'
    ) {
      // Each kind mirrors its sim gate: a producer needs clear ground of the right terrain, a
      // building clear ground, a port/splitter a belt tile (a port also the building its arrow
      // designates). Everything must also be affordable. The result drives a green "clear to
      // place" ring or a red "blocked" fill so validity reads before the click.
      const placeable =
        item.kind === 'producer'
          ? producerValid(item, tile.x, tile.y)
          : item.kind === 'building'
            ? buildingValid(item, tile.x, tile.y)
            : item.kind === 'splitter'
              ? splitterValid(tile.x, tile.y)
              : // port
                !item.port || portValid(item.port, tile.x, tile.y)
      const affordable = !item.cost || item.cost.length === 0 || canAfford(state, item.cost)
      renderer.setGhost({
        kind: 'rect',
        x: tile.x,
        y: tile.y,
        w: item.w,
        h: item.h,
        color: item.color,
        valid: placeable && affordable,
        // Only a port carries a meaningful facing arrow; rotation is a no-op for the rest.
        ...(item.kind === 'port' ? { dir: placeDir } : {}),
      })
      return
    }
    // Belt: until a drag begins, preview the single start tile under the cursor.
    if (!beltStart) {
      renderer.setGhost({ kind: 'rect', x: tile.x, y: tile.y, w: 1, h: 1, color: item.color })
    }
  }

  /** Draw the delete ghost at `tile`: the removable footprint outlined in red, or a single red
   *  tile when nothing there can be deleted (delete mode only). */
  const previewDeleteGhost = (tile: GridCoord): void => {
    ghostTile = { x: tile.x, y: tile.y }
    const fp = deletableAt(tile.x, tile.y) ?? { x: tile.x, y: tile.y, w: 1, h: 1 }
    renderer.setGhost({ kind: 'rect', x: fp.x, y: fp.y, w: fp.w, h: fp.h, color: INVALID_COLOR })
  }

  /** Top-left origin for stamping blueprint `bp` centred on the cursor tile — shared by ghost + stamp. */
  const pasteOrigin = (tile: GridCoord, bp: Blueprint): GridCoord => ({
    x: tile.x - Math.floor(bp.w / 2),
    y: tile.y - Math.floor(bp.h / 2),
  })

  /** Draw the translucent multi-cell paste preview for the pending blueprint centred on `tile`. */
  const drawPasteGhost = (tile: GridCoord): void => {
    const bp = blueprintStore.get().pending
    if (!bp) {
      renderer.setGhost(null)
      return
    }
    const o = pasteOrigin(tile, bp)
    renderer.setGhost({ kind: 'cells', cells: blueprintGhostCells(bp, o.x, o.y) })
  }

  /** Fallback inspector name for a pasted placement of the given kind (used when the capture had none). */
  const pasteName = (p: ReturnType<typeof blueprintPlacements>[number]): string => {
    if (p.name) return p.name
    switch (p.kind) {
      case 'belt':
        return 'Conveyor belt'
      case 'port':
        return p.port === 'output' ? 'Output port' : 'Input port'
      case 'splitter':
        return 'Splitter'
      case 'crafter':
        return 'Machine'
      default:
        return 'Structure'
    }
  }

  /** The inspect-registry `type` string a placement records under (crafters read as 'producer'). */
  const placementRegistryType = (p: Placement): string =>
    p.kind === 'belt'
      ? 'belt'
      : p.kind === 'port'
        ? p.port
        : p.kind === 'crafter'
          ? 'producer'
          : p.kind // 'building' | 'splitter'

  /** Stamp the pending blueprint at the cursor: enqueue every placement and name each anchor tile.
   * The whole stamp is recorded as ONE undoable step, so a single Ctrl+Z tears the paste back out.
   * Paste and delete-undo share {@link placementToStep}, so a pasted and a re-placed object match. */
  const stampPaste = (tile: GridCoord): void => {
    const bp = blueprintStore.get().pending
    if (!bp) return
    const o = pasteOrigin(tile, bp)
    const steps: PlacedStep[] = []
    for (const p of blueprintPlacements(bp, o.x, o.y)) {
      // Paste works from placed colours, so each tile is charged the same cost the palette assigns
      // to that colour (a belt run scaled by its length) — pasting is never cheaper than building.
      const step = placementToStep(p)
      dispatchCommand(world, step.cmd)
      const anchor = step.tiles[0]!
      registry.record(anchor.x, anchor.y, { name: pasteName(p), type: placementRegistryType(p) })
      steps.push(step)
    }
    recordGesture('Paste', steps)
  }

  /**
   * Q "pipette": arm the build tool matching whatever sits under the cursor. Reads the belt grid
   * (belt/port/splitter) or the building store (crafter/store), matches it against the current build
   * catalogue by kind + colour, and selects that tool (a port also adopts the picked facing). A no-op
   * over empty ground or an object with no matching tool (e.g. terrain/scenery).
   */
  const pickAt = (tile: GridCoord, copyConfig = false): void => {
    // A plain pick drops any copied config; Shift+Q below refills it from the picked crafter.
    if (!copyConfig) pendingRecipe = null
    const items = buildStore.get().items
    const t = grid.index.get(tileKey(tile.x, tile.y))
    if (t !== undefined) {
      const kind = grid.kind[t]!
      if (kind === KIND_OUTPUT || kind === KIND_INPUT) {
        const port = kind === KIND_OUTPUT ? 'output' : 'input'
        const item = items.find((i) => i.kind === 'port' && i.port === port && !i.locked)
        if (item) {
          placeDir = grid.face[t]! & 3
          buildStore.select(item.id)
        }
        return
      }
      if (kind === KIND_SPLITTER) {
        const item = items.find((i) => i.kind === 'splitter' && !i.locked)
        if (item) buildStore.select(item.id)
        return
      }
      const color = world.components.Renderable.color[grid.trackEid[t]!]
      const item =
        items.find((i) => i.kind === 'belt' && i.color === color && !i.locked) ??
        items.find((i) => i.kind === 'belt' && !i.locked)
      if (item) buildStore.select(item.id)
      return
    }
    const b = buildingAt(state.buildings, tile.x, tile.y)
    if (b < 0) return
    const color = world.components.Renderable.color[state.buildings.eid[b]!]
    if (state.buildings.crafts[b]) {
      const def = color !== undefined ? machines.byColor.get(color) : undefined
      const item = items.find((i) => i.kind === 'producer' && i.id === def?.id && !i.locked)
      if (item) buildStore.select(item.id)
      // Shift+Q also copies the crafter's recipe so the next placements of this machine adopt it.
      if (copyConfig && def && color !== undefined) {
        const recipeInt = state.buildings.recipe[b]!
        const choice = def.recipes.find((r) => r.int === recipeInt)
        pendingRecipe = choice ? { color, recipe: choice } : null
      }
      return
    }
    const item = items.find((i) => i.kind === 'building' && i.color === color && !i.locked)
    if (item) buildStore.select(item.id)
  }

  renderer.onPick = (tile, copyConfig) => pickAt(tile, copyConfig)

  renderer.onTileHover = (tile) => {
    cursorTile = { x: tile.x, y: tile.y }
    const mode = blueprintStore.get().mode
    if (mode === 'paste') {
      drawPasteGhost(tile)
      return
    }
    if (mode === 'copy-select') {
      // The marquee is drawn on drag-move; a bare hover shows nothing.
      if (!selectStart) renderer.setGhost(null)
      return
    }
    if (buildStore.get().deleting) {
      previewDeleteGhost(tile)
      return
    }
    const item = buildStore.selectedItem()
    if (!item) {
      renderer.setGhost(null)
      ghostTile = null
      // pointermove fires per pixel; only re-resolve when the hovered tile actually
      // changes, bounding the entity scan to once per tile crossing.
      if (hoverTile && hoverTile.x === tile.x && hoverTile.y === tile.y) return
      hoverTile = { x: tile.x, y: tile.y }
      if (!pinned) applyView()
      return
    }
    previewGhost(item, tile)
  }

  // R rotates the armed port's arrow, then redraws the ghost in place so the new facing shows.
  renderer.onRotate = () => {
    placeDir = (placeDir + 1) & 3
    const item = buildStore.selectedItem()
    if (item && ghostTile) previewGhost(item, ghostTile)
  }

  // Mouse-wheel rotates an armed port's facing (up = clockwise, down = anticlockwise) instead of
  // zooming; over anything else the wheel falls through to the camera zoom. Returns whether claimed.
  renderer.onWheel = (deltaY) => {
    const item = buildStore.selectedItem()
    if (item?.kind !== 'port') return false
    placeDir = deltaY < 0 ? (placeDir + 1) & 3 : (placeDir + 3) & 3
    if (ghostTile) previewGhost(item, ghostTile)
    return true
  }

  renderer.onDragStart = (tile) => {
    const mode = blueprintStore.get().mode
    if (mode === 'copy-select') {
      selectStart = { x: tile.x, y: tile.y }
      return
    }
    if (mode === 'paste') return // paste stamps on release (a click), not on press.
    pressTile = { x: tile.x, y: tile.y }
    if (buildStore.selectedItem()?.kind === 'belt') beltStart = { x: tile.x, y: tile.y }
  }

  renderer.onDragMove = (tile, shiftKey) => {
    // Copy-select: preview the marquee rectangle from the drag's start corner to the cursor.
    if (blueprintStore.get().mode === 'copy-select') {
      if (selectStart) {
        renderer.setGhost({
          kind: 'line',
          ax: selectStart.x,
          ay: selectStart.y,
          bx: tile.x,
          by: tile.y,
          color: 0x66ccff,
        })
      }
      return
    }
    // Delete drag: preview the sweep rectangle in red from the press corner to the cursor.
    if (buildStore.get().deleting) {
      if (pressTile) {
        renderer.setGhost({
          kind: 'line',
          ax: pressTile.x,
          ay: pressTile.y,
          bx: tile.x,
          by: tile.y,
          color: INVALID_COLOR,
        })
      }
      return
    }
    // Machine/port drag: preview the projected line the stamp will follow, with a stamp count.
    const armed = buildStore.selectedItem()
    if (pressTile && (armed?.kind === 'producer' || armed?.kind === 'port')) {
      const { dx, dy, length } = projectBelt(pressTile.x, pressTile.y, tile.x, tile.y)
      const step = armed.kind === 'producer' ? Math.max(armed.w, armed.h) : 1
      const count = lineTiles(pressTile, tile, step).length
      renderer.setGhost({
        kind: 'line',
        ax: pressTile.x,
        ay: pressTile.y,
        bx: pressTile.x + dx * (length - 1),
        by: pressTile.y + dy * (length - 1),
        color: armed.color,
        ...(count > 1 ? { label: `×${count}` } : {}),
      })
      return
    }
    if (!beltStart) return
    const item = buildStore.selectedItem()
    if (item?.kind !== 'belt') return
    // Preview the L-shaped belt from the start tile to the cursor: a run along the dominant axis to
    // the corner, then the perpendicular run to B (Shift flips which axis goes first). A straight
    // drag degenerates to a single leg, previewing exactly as before. The label counts the full path.
    const path = projectBeltPath(beltStart.x, beltStart.y, tile.x, tile.y, shiftKey)
    renderer.setGhost({
      kind: 'line',
      ax: beltStart.x,
      ay: beltStart.y,
      bx: tile.x,
      by: tile.y,
      color: item.color,
      ...(path.legs.length > 1 ? { corner: { x: path.corner.x, y: path.corner.y } } : {}),
      ...(path.length > 1 ? { label: `×${path.length}` } : {}),
    })
  }

  renderer.onDragEnd = (tile, shiftKey) => {
    const mode = blueprintStore.get().mode
    if (mode === 'copy-select') {
      const start = selectStart
      selectStart = null
      renderer.setGhost(null)
      if (!start) return
      const rect = normalizeRect(start.x, start.y, tile.x, tile.y)
      const bp = captureBlueprint(state, world, registry, rect)
      // Hand the capture to the store: it either arms the paste ghost or opens the naming flow
      // (save-to-library). After capture, redraw the ghost at the cursor if we're now pasting.
      blueprintStore.captured(bp)
      if (blueprintStore.get().mode === 'paste') drawPasteGhost(tile)
      return
    }
    if (mode === 'paste') {
      // A press+release stamps the pending blueprint; it stays armed for repeat stamping.
      stampPaste(tile)
      drawPasteGhost(tile)
      return
    }
    if (buildStore.get().deleting) {
      const start = pressTile
      pressTile = null
      renderer.setGhost(null)
      if (!start) return
      // A click deletes the single object under the cursor (its whole footprint); a drag sweep-
      // deletes every object anchored in the marquee. Either way, resolve the region rect first.
      let rect: { x0: number; y0: number; x1: number; y1: number } | null = null
      if (start.x === tile.x && start.y === tile.y) {
        const fp = deletableAt(tile.x, tile.y)
        if (fp) rect = normalizeRect(fp.x, fp.y, fp.x + fp.w - 1, fp.y + fp.h - 1)
      } else {
        rect = normalizeRect(start.x, start.y, tile.x, tile.y)
      }
      if (!rect) return
      // Capture the objects (read-only) BEFORE removing so the deletion can be undone, then remove
      // exactly those captured tiles — keeping delete and undo perfectly symmetric.
      const steps = captureRegionSteps(rect)
      let removed = false
      for (const s of steps) {
        for (const t of s.tiles) {
          if (deletableAt(t.x, t.y)) {
            removeTile(t.x, t.y)
            removed = true
          }
        }
      }
      if (removed) {
        sfx.play('remove')
        recordDeletion('Delete', steps)
      }
      return
    }
    const item = buildStore.selectedItem()
    if (!item) {
      // Inspect mode: a press+release on the same tile is a click → toggle the pin.
      const start = pressTile
      pressTile = null
      if (start && start.x === tile.x && start.y === tile.y) inspectClick(tile)
      return
    }
    // A drag (press ≠ release) line-stamps a row of ports/machines; a click places one.
    const dragStart =
      pressTile && !(pressTile.x === tile.x && pressTile.y === tile.y) ? pressTile : null
    pressTile = null
    if (item.kind === 'building') {
      const params = {
        x: tile.x,
        y: tile.y,
        w: item.w,
        h: item.h,
        color: item.color,
        accepts: item.accepts.map((color) => ({ color, cap: item.storage })),
        ...(item.researchLab ? { researchLab: true } : {}),
        ...(item.depot ? { depot: true } : {}),
        ...(item.cost ? { cost: item.cost } : {}),
        ...(item.upkeep ? { upkeep: item.upkeep } : {}),
      }
      enqueuePlaceBuilding(world, params)
      registry.record(tile.x, tile.y, { name: item.name, type: 'building' })
      recordGesture(item.name, [
        { cmd: { type: 'place_building', ...params }, tiles: [tile], refund: item.cost },
      ])
      return
    }
    // Port: drops onto the belt tile under the cursor (ignored if there's no belt there); it
    // links to an adjacent building, draining/feeding it. A drag stamps one port per tile.
    if (item.kind === 'port' && item.port) {
      const port = item.port
      const tiles = dragStart ? lineTiles(dragStart, tile, 1) : [tile]
      const steps = tiles.map((t) => {
        const params = {
          x: t.x,
          y: t.y,
          port,
          color: item.color,
          spawnEvery: item.spawnEvery,
          dir: placeDir,
          ...(item.cost ? { cost: item.cost } : {}),
        }
        enqueuePlacePort(world, params)
        registry.record(t.x, t.y, { name: item.name, type: port })
        return { cmd: { type: 'place_port', ...params }, tiles: [t], refund: item.cost }
      })
      recordGesture(item.name, steps)
      return
    }
    // Splitter: also drops onto the belt tile under the cursor (ignored off-belt).
    if (item.kind === 'splitter') {
      const params = {
        x: tile.x,
        y: tile.y,
        color: item.color,
        ...(item.cost ? { cost: item.cost } : {}),
      }
      enqueuePlaceSplitter(world, params)
      registry.record(tile.x, tile.y, { name: item.name, type: 'splitter' })
      recordGesture(item.name, [
        { cmd: { type: 'place_splitter', ...params }, tiles: [tile], refund: item.cost },
      ])
      return
    }
    // Machine (mine/furnace/assembler…): an off-belt crafter placed EMPTY — the player picks its
    // recipe afterward in the sidebar (Factorio-style). Extraction machines (mines/derricks) are
    // the exception: they auto-adopt the recipe matching the terrain they're dropped on, so a drill
    // on a coal seam immediately mines coal. Off a matching deposit it places idle until moved.
    if (item.kind === 'producer') {
      const def = machines.byColor.get(item.color)
      // A drag stamps a flush row (stepping by the footprint); each tile resolves its own recipe:
      // extraction machines auto-adopt the terrain under that tile, other machines adopt a recipe
      // copied via the Shift+Q pipette (same colour) so a configured row lays down in one pass.
      const tiles = dragStart ? lineTiles(dragStart, tile, Math.max(item.w, item.h)) : [tile]
      const steps = tiles.map((t) => {
        const recipe = def?.extraction
          ? def.recipes.find(
              (r) => r.requiresTerrainType === terrainTypeAt(state.terrain, t.x, t.y),
            )
          : pendingRecipe?.color === item.color
            ? pendingRecipe.recipe
            : undefined
        const params = {
          x: t.x,
          y: t.y,
          w: item.w,
          h: item.h,
          color: item.color,
          craftEvery: recipe?.craftEvery ?? item.produceEvery,
          storageCap: item.storage,
          ...(recipe ? { recipe: recipe.int, inputs: recipe.inputs, outputs: recipe.outputs } : {}),
          ...(item.cost ? { cost: item.cost } : {}),
          ...(item.upkeep ? { upkeep: item.upkeep } : {}),
        }
        enqueuePlaceCrafter(world, params)
        registry.record(t.x, t.y, { name: item.name, type: 'producer' })
        return { cmd: { type: 'place_crafter', ...params }, tiles: [t], refund: item.cost }
      })
      recordGesture(item.name, steps)
      return
    }
    // Belt: place the dragged L-path, ignoring a zero-length (no-drag) gesture. A straight drag
    // yields one leg (identical to before); a real bend yields two legs (A→corner, corner→B) that
    // share the corner tile — enqueued in that order so leg 2 re-aims the corner to turn the belt,
    // and recorded as ONE undoable gesture. Shift flips which axis the first leg follows.
    const start = beltStart
    beltStart = null
    if (!start || (start.x === tile.x && start.y === tile.y)) return
    const path = projectBeltPath(start.x, start.y, tile.x, tile.y, shiftKey)
    const steps: PlacedStep[] = []
    for (let li = 0; li < path.legs.length; li++) {
      const leg = path.legs[li]!
      // The corner tile belongs to leg 0. Leg 1 still rasterizes over it (re-aiming it so the belt
      // turns), but must not be charged, named or removed twice — so skip its start tile for cost
      // and the recorded tiles, keeping charge and refund exactly balanced across an undo/redo cycle.
      const skipStart = li > 0
      const tileCount = leg.length - (skipStart ? 1 : 0)
      const legCost = scaleCost(item.cost, tileCount)
      const legTiles: { x: number; y: number }[] = []
      for (let i = skipStart ? 1 : 0; i < leg.length; i++) {
        const tx = leg.ax + leg.dx * i
        const ty = leg.ay + leg.dy * i
        registry.record(tx, ty, { name: item.name, type: 'belt' })
        legTiles.push({ x: tx, y: ty })
      }
      const beltParams = {
        ax: leg.ax,
        ay: leg.ay,
        bx: leg.bx,
        by: leg.by,
        color: item.color,
        moveEvery: item.moveEvery,
        ...(legCost ? { cost: legCost } : {}),
      }
      enqueuePlaceBelt(world, beltParams)
      steps.push({ cmd: { type: 'place_belt', ...beltParams }, tiles: legTiles, refund: legCost })
    }
    recordGesture(item.name, steps)
  }

  // The sidebar's close button asks us to release the pin through the store.
  inspectStore.onUnpin(() => {
    pinned = null
    applyView()
  })

  // Selecting a build tool or arming delete enters an action mode (drop any inspection);
  // deselecting returns to inspect. Arming a build tool also cancels any clipboard mode — the
  // two are mutually exclusive.
  buildStore.subscribe(() => {
    if (buildStore.selectedItem() || buildStore.get().deleting) {
      if (blueprintStore.get().mode !== 'idle') blueprintStore.cancel()
      renderer.setGhost(null)
      clearInspect()
    } else if (blueprintStore.get().mode === 'idle') {
      applyView()
    }
  })

  // Entering a clipboard mode (copy-select / paste) is mutually exclusive with the build/delete
  // tools and inspect; leaving it returns to inspect. Redraw the paste ghost at the last cursor
  // tile so switching to paste shows a preview immediately (no pointer move needed).
  blueprintStore.subscribe(() => {
    const mode = blueprintStore.get().mode
    if (mode !== 'idle') {
      selectStart = null
      if (buildStore.selectedItem() || buildStore.get().deleting) buildStore.clearSelection()
      clearInspect()
      if (mode === 'paste' && cursorTile) drawPasteGhost(cursorTile)
      else renderer.setGhost(null)
    } else {
      renderer.setGhost(null)
      ghostTile = null
      if (!buildStore.selectedItem() && !buildStore.get().deleting) applyView()
    }
  })

  // Right-click cancels the armed build/delete tool or the clipboard mode, returning to inspect.
  renderer.onCancel = () => {
    if (blueprintStore.get().mode !== 'idle') {
      blueprintStore.cancel()
      return
    }
    if (!buildStore.selectedItem() && !buildStore.get().deleting) return
    renderer.setGhost(null)
    ghostTile = null
    buildStore.clearSelection()
  }

  // The render loop's throttled refresh samples utilization; every other caller of `applyView`
  // (hover/click/mode-switch) leaves `sample` at its default false.
  return { refresh: () => applyView(true) }
}
