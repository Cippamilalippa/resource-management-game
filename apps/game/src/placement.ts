import type { GameWorld } from '@factory/engine/core'
import type { Renderer } from '@factory/engine/render'
import type { GridCoord } from '@factory/shared'
import {
  enqueuePlaceBuilding,
  enqueuePlaceBelt,
  enqueuePlacePort,
  enqueuePlaceCrafter,
  enqueuePlaceSplitter,
  enqueueSetRecipe,
  enqueueRemove,
  projectBelt,
  terrainTypeOf,
  terrainTypeAt,
  buildingAt,
  tileKey,
  KIND_OUTPUT,
  KIND_INPUT,
  KIND_SPLITTER,
  type GameState,
} from './gameLogic.ts'
import { buildStore, type BuildItem } from './buildStore.ts'
import { blueprintStore } from './blueprintStore.ts'
import {
  captureBlueprint,
  blueprintPlacements,
  blueprintGhostCells,
  normalizeRect,
  type Blueprint,
} from './blueprint.ts'
import { resolveInspect, type InspectInfo, type InspectRegistry } from './inspect.ts'
import { inspectStore } from './inspectStore.ts'
import { recipeStore } from './recipeStore.ts'
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

  /** The colour of whatever deletable object sits at (x, y), for looking up its refund. */
  const colorAt = (x: number, y: number): number | null => {
    const info = resolveInspect(world, grid, state.buildings, state.villages, registry, x, y)
    return info ? info.color : null
  }

  // The recipe picker (sidebar) drives recipe changes on the pinned crafter through here — only the
  // host owns the world, so the store just carries intent and this enqueues the command.
  recipeStore.setController({
    choose: (recipe: RecipeChoice) => {
      const sel = recipeStore.get()
      if (!sel) return
      enqueueSetRecipe(world, {
        x: sel.x,
        y: sel.y,
        recipe: recipe.int,
        inputs: recipe.inputs,
        outputs: recipe.outputs,
        craftEvery: recipe.craftEvery,
        storageCap: recipe.storageCap,
      })
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
  // Ghost tint for a placement the sim would reject (off-belt or wrong terrain), and the
  // tint the delete tool paints the object it would remove.
  const INVALID_COLOR = 0xff5555

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
   * Whether a producer tool could legally drop on the tile (x, y): a producer is now an
   * off-belt crafter, so it just needs matching terrain (if it declares `requiresTerrain`).
   * Mirrors the sim's `place_crafter` gate so the ghost preview agrees with placement.
   */
  const producerValid = (item: BuildItem, x: number, y: number): boolean => {
    if (!item.requiresTerrain) return true
    return terrainTypeAt(state.terrain, x, y) === terrainTypeOf(item.requiresTerrain)
  }

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
  // Inspect-mode state: the last hovered tile, and the pinned object (tile + footprint), if any.
  let hoverTile: GridCoord | null = null
  let pinned: { tile: GridCoord; footprint: InspectInfo['footprint'] } | null = null
  // Clipboard-mode state: the last tile the cursor was over (so a mode switch can redraw the paste
  // ghost without a fresh pointer event), and the copy-select drag's start corner while dragging.
  let cursorTile: GridCoord | null = null
  let selectStart: GridCoord | null = null

  /** Push the current inspect view (pinned wins over hover) to the store and highlight. */
  const applyView = (): void => {
    if (pinned) {
      const info = resolveInspect(
        world,
        grid,
        state.buildings,
        state.villages,
        registry,
        pinned.tile.x,
        pinned.tile.y,
      )
      if (info) {
        inspectStore.set({ info, pinned: true })
        renderer.setHighlight({ ...info.footprint, color: info.color, selected: true })
        publishRecipe(info) // recipe picker follows the pinned crafter
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
          registry,
          hoverTile.x,
          hoverTile.y,
        )
      : null
    inspectStore.set({ info, pinned: false })
    renderer.setHighlight(info ? { ...info.footprint, color: info.color, selected: false } : null)
    publishRecipe(null) // nothing pinned → no recipe picker
  }

  /** Clear all inspect state (entering build mode, or nothing under the cursor). */
  const clearInspect = (): void => {
    pinned = null
    hoverTile = null
    inspectStore.set({ info: null, pinned: false })
    renderer.setHighlight(null)
    recipeStore.set(null)
  }

  /** A click in inspect mode: pin the object under the cursor, or unpin (toggle / empty). */
  const inspectClick = (tile: GridCoord): void => {
    const info = resolveInspect(
      world,
      grid,
      state.buildings,
      state.villages,
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
      // A producer is terrain-gated and a port needs the building its arrow designates: tint the
      // ghost red where it could not actually place.
      const invalid =
        (item.kind === 'producer' && !producerValid(item, tile.x, tile.y)) ||
        (item.kind === 'port' && !!item.port && !portValid(item.port, tile.x, tile.y))
      renderer.setGhost({
        kind: 'rect',
        x: tile.x,
        y: tile.y,
        w: item.w,
        h: item.h,
        color: invalid ? INVALID_COLOR : item.color,
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

  /** Stamp the pending blueprint at the cursor: enqueue every placement and name each tile. */
  const stampPaste = (tile: GridCoord): void => {
    const bp = blueprintStore.get().pending
    if (!bp) return
    const o = pasteOrigin(tile, bp)
    for (const p of blueprintPlacements(bp, o.x, o.y)) {
      // Paste works from placed colours, so each tile is charged the same cost the palette assigns
      // to that colour (a belt run scaled by its length) — pasting is never cheaper than building.
      const cost = costForColor(p.color)
      switch (p.kind) {
        case 'belt': {
          const beltCost = scaleCost(cost, projectBelt(p.ax, p.ay, p.bx, p.by).length)
          enqueuePlaceBelt(world, {
            ax: p.ax,
            ay: p.ay,
            bx: p.bx,
            by: p.by,
            color: p.color,
            moveEvery: p.moveEvery,
            face: p.face,
            ...(beltCost ? { cost: beltCost } : {}),
          })
          registry.record(p.ax, p.ay, { name: pasteName(p), type: 'belt' })
          break
        }
        case 'port':
          enqueuePlacePort(world, {
            x: p.x,
            y: p.y,
            port: p.port,
            color: p.color,
            spawnEvery: p.spawnEvery,
            dir: p.dir,
            ...(cost ? { cost } : {}),
          })
          registry.record(p.x, p.y, { name: pasteName(p), type: p.port })
          break
        case 'splitter':
          enqueuePlaceSplitter(world, {
            x: p.x,
            y: p.y,
            color: p.color,
            ...(cost ? { cost } : {}),
          })
          registry.record(p.x, p.y, { name: pasteName(p), type: 'splitter' })
          break
        case 'building':
          enqueuePlaceBuilding(world, {
            x: p.x,
            y: p.y,
            w: p.w,
            h: p.h,
            color: p.color,
            accepts: p.accepts,
            ...(p.researchLab ? { researchLab: true } : {}),
            ...(cost ? { cost } : {}),
          })
          registry.record(p.x, p.y, { name: pasteName(p), type: 'building' })
          break
        case 'crafter':
          enqueuePlaceCrafter(world, {
            x: p.x,
            y: p.y,
            w: p.w,
            h: p.h,
            color: p.color,
            craftEvery: p.craftEvery,
            storageCap: p.storageCap,
            ...(p.recipe ? { recipe: p.recipe, inputs: p.inputs, outputs: p.outputs } : {}),
            ...(cost ? { cost } : {}),
          })
          registry.record(p.x, p.y, { name: pasteName(p), type: 'producer' })
          break
      }
    }
  }

  /**
   * Q "pipette": arm the build tool matching whatever sits under the cursor. Reads the belt grid
   * (belt/port/splitter) or the building store (crafter/store), matches it against the current build
   * catalogue by kind + colour, and selects that tool (a port also adopts the picked facing). A no-op
   * over empty ground or an object with no matching tool (e.g. terrain/scenery).
   */
  const pickAt = (tile: GridCoord): void => {
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
      return
    }
    const item = items.find((i) => i.kind === 'building' && i.color === color && !i.locked)
    if (item) buildStore.select(item.id)
  }

  renderer.onPick = (tile) => pickAt(tile)

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

  renderer.onDragMove = (tile) => {
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
    if (!beltStart) return
    const item = buildStore.selectedItem()
    if (item?.kind !== 'belt') return
    // Preview the projected (axis-aligned) belt from the start tile to the cursor.
    const { dx, dy, length } = projectBelt(beltStart.x, beltStart.y, tile.x, tile.y)
    renderer.setGhost({
      kind: 'line',
      ax: beltStart.x,
      ay: beltStart.y,
      bx: beltStart.x + dx * (length - 1),
      by: beltStart.y + dy * (length - 1),
      color: item.color,
    })
  }

  renderer.onDragEnd = (tile) => {
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
      // A press+release on the same tile is a click → delete the object under the cursor.
      const start = pressTile
      pressTile = null
      if (start && start.x === tile.x && start.y === tile.y && deletableAt(tile.x, tile.y)) {
        // Refund the removed object's build cost (the sim scales it by the game's refund setting).
        const color = colorAt(tile.x, tile.y)
        const refund = color === null ? undefined : costForColor(color)
        enqueueRemove(world, { x: tile.x, y: tile.y, ...(refund ? { refund } : {}) })
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
    pressTile = null
    if (item.kind === 'building') {
      enqueuePlaceBuilding(world, {
        x: tile.x,
        y: tile.y,
        w: item.w,
        h: item.h,
        color: item.color,
        accepts: item.accepts.map((color) => ({ color, cap: item.storage })),
        ...(item.researchLab ? { researchLab: true } : {}),
        ...(item.depot ? { depot: true } : {}),
        ...(item.cost ? { cost: item.cost } : {}),
      })
      registry.record(tile.x, tile.y, { name: item.name, type: 'building' })
      return
    }
    // Port: drops onto the belt tile under the cursor (ignored if there's no belt there); it
    // links to an adjacent building, draining/feeding it.
    if (item.kind === 'port' && item.port) {
      enqueuePlacePort(world, {
        x: tile.x,
        y: tile.y,
        port: item.port,
        color: item.color,
        spawnEvery: item.spawnEvery,
        dir: placeDir,
        ...(item.cost ? { cost: item.cost } : {}),
      })
      registry.record(tile.x, tile.y, { name: item.name, type: item.port })
      return
    }
    // Splitter: also drops onto the belt tile under the cursor (ignored off-belt).
    if (item.kind === 'splitter') {
      enqueuePlaceSplitter(world, {
        x: tile.x,
        y: tile.y,
        color: item.color,
        ...(item.cost ? { cost: item.cost } : {}),
      })
      registry.record(tile.x, tile.y, { name: item.name, type: 'splitter' })
      return
    }
    // Machine (mine/furnace/assembler…): an off-belt crafter placed EMPTY — the player picks its
    // recipe afterward in the sidebar (Factorio-style). Extraction machines (mines/derricks) are
    // the exception: they auto-adopt the recipe matching the terrain they're dropped on, so a drill
    // on a coal seam immediately mines coal. Off a matching deposit it places idle until moved.
    if (item.kind === 'producer') {
      const def = machines.byColor.get(item.color)
      const recipe = def?.extraction
        ? def.recipes.find(
            (r) => r.requiresTerrainType === terrainTypeAt(state.terrain, tile.x, tile.y),
          )
        : undefined
      enqueuePlaceCrafter(world, {
        x: tile.x,
        y: tile.y,
        w: item.w,
        h: item.h,
        color: item.color,
        craftEvery: recipe?.craftEvery ?? item.produceEvery,
        storageCap: item.storage,
        ...(recipe ? { recipe: recipe.int, inputs: recipe.inputs, outputs: recipe.outputs } : {}),
        ...(item.cost ? { cost: item.cost } : {}),
      })
      registry.record(tile.x, tile.y, { name: item.name, type: 'producer' })
      return
    }
    // Belt: place the dragged segment, ignoring a zero-length (no-drag) gesture.
    const start = beltStart
    beltStart = null
    if (!start || (start.x === tile.x && start.y === tile.y)) return
    // Name every tile along the projected run so each is inspectable; the run length also scales
    // the belt's per-tile cost into the all-or-nothing charge the sim applies.
    const { dx, dy, length } = projectBelt(start.x, start.y, tile.x, tile.y)
    const beltCost = scaleCost(item.cost, length)
    enqueuePlaceBelt(world, {
      ax: start.x,
      ay: start.y,
      bx: tile.x,
      by: tile.y,
      color: item.color,
      moveEvery: item.moveEvery,
      ...(beltCost ? { cost: beltCost } : {}),
    })
    for (let i = 0; i < length; i++) {
      registry.record(start.x + dx * i, start.y + dy * i, { name: item.name, type: 'belt' })
    }
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

  return { refresh: applyView }
}
