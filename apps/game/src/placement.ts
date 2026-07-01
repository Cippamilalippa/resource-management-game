import type { GameWorld } from '@factory/engine/core'
import type { Renderer } from '@factory/engine/render'
import type { GridCoord } from '@factory/shared'
import {
  enqueuePlaceBuilding,
  enqueuePlaceBelt,
  enqueuePlacePort,
  enqueuePlaceCrafter,
  enqueuePlaceSplitter,
  enqueueRemove,
  projectBelt,
  terrainTypeOf,
  terrainTypeAt,
  buildingAt,
  tileKey,
  type GameState,
} from './gameLogic.ts'
import { buildStore, type BuildItem } from './buildStore.ts'
import { resolveInspect, type InspectInfo, type InspectRegistry } from './inspect.ts'
import { inspectStore } from './inspectStore.ts'

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
): { refresh: () => void } {
  const grid = state.grid
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
  }

  /** Clear all inspect state (entering build mode, or nothing under the cursor). */
  const clearInspect = (): void => {
    pinned = null
    hoverTile = null
    inspectStore.set({ info: null, pinned: false })
    renderer.setHighlight(null)
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

  renderer.onTileHover = (tile) => {
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
    pressTile = { x: tile.x, y: tile.y }
    if (buildStore.selectedItem()?.kind === 'belt') beltStart = { x: tile.x, y: tile.y }
  }

  renderer.onDragMove = (tile) => {
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
    if (buildStore.get().deleting) {
      // A press+release on the same tile is a click → delete the object under the cursor.
      const start = pressTile
      pressTile = null
      if (start && start.x === tile.x && start.y === tile.y && deletableAt(tile.x, tile.y)) {
        enqueueRemove(world, { x: tile.x, y: tile.y })
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
      })
      registry.record(tile.x, tile.y, { name: item.name, type: item.port })
      return
    }
    // Splitter: also drops onto the belt tile under the cursor (ignored off-belt).
    if (item.kind === 'splitter') {
      enqueuePlaceSplitter(world, { x: tile.x, y: tile.y, color: item.color })
      registry.record(tile.x, tile.y, { name: item.name, type: 'splitter' })
      return
    }
    // Crafter (farm/mine/furnace/assembler…): an off-belt building running a recipe. Terrain-
    // gated extraction crafters are valid only on matching terrain; the sim re-checks and drops
    // a bad placement. The recipe's inputs/outputs ride on the build item.
    if (item.kind === 'producer') {
      enqueuePlaceCrafter(world, {
        x: tile.x,
        y: tile.y,
        w: item.w,
        h: item.h,
        color: item.color,
        inputs: item.craftInputs ?? [],
        outputs: item.craftOutputs ?? [{ color: item.itemColor, amount: 1 }],
        craftEvery: item.produceEvery,
        storageCap: item.storage,
        ...(item.requiresTerrain
          ? { requiresTerrainType: terrainTypeOf(item.requiresTerrain) }
          : {}),
      })
      registry.record(tile.x, tile.y, { name: item.name, type: 'producer' })
      return
    }
    // Belt: place the dragged segment, ignoring a zero-length (no-drag) gesture.
    const start = beltStart
    beltStart = null
    if (!start || (start.x === tile.x && start.y === tile.y)) return
    enqueuePlaceBelt(world, {
      ax: start.x,
      ay: start.y,
      bx: tile.x,
      by: tile.y,
      color: item.color,
      moveEvery: item.moveEvery,
    })
    // Name every tile along the projected run so each is inspectable.
    const { dx, dy, length } = projectBelt(start.x, start.y, tile.x, tile.y)
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
  // deselecting returns to inspect.
  buildStore.subscribe(() => {
    if (buildStore.selectedItem() || buildStore.get().deleting) {
      renderer.setGhost(null)
      clearInspect()
    } else {
      applyView()
    }
  })

  // Right-click cancels the armed build/delete tool, returning to inspect mode.
  renderer.onCancel = () => {
    if (!buildStore.selectedItem() && !buildStore.get().deleting) return
    renderer.setGhost(null)
    ghostTile = null
    buildStore.clearSelection()
  }

  return { refresh: applyView }
}
