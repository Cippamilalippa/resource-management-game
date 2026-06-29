import type { GameWorld } from '@factory/engine/core'
import type { Renderer } from '@factory/engine/render'
import type { GridCoord } from '@factory/shared'
import {
  enqueuePlaceBuilding,
  enqueuePlaceBelt,
  enqueuePlacePort,
  enqueuePlaceProducer,
  enqueuePlaceSplitter,
  projectBelt,
  type GameState,
} from './gameLogic.ts'
import { buildStore } from './buildStore.ts'
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
      const info = resolveInspect(world, grid, registry, pinned.tile.x, pinned.tile.y)
      if (info) {
        inspectStore.set({ info, pinned: true })
        renderer.setHighlight({ ...info.footprint, color: info.color, selected: true })
        return
      }
      pinned = null // the pinned object vanished — fall through to hover.
    }
    const info = hoverTile ? resolveInspect(world, grid, registry, hoverTile.x, hoverTile.y) : null
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
    const info = resolveInspect(world, grid, registry, tile.x, tile.y)
    if (!info) {
      pinned = null
    } else if (pinned && sameFootprint(pinned.footprint, info.footprint)) {
      pinned = null
    } else {
      pinned = { tile: { x: tile.x, y: tile.y }, footprint: info.footprint }
    }
    applyView()
  }

  renderer.onTileHover = (tile) => {
    const item = buildStore.selectedItem()
    if (!item) {
      renderer.setGhost(null)
      // pointermove fires per pixel; only re-resolve when the hovered tile actually
      // changes, bounding the entity scan to once per tile crossing.
      if (hoverTile && hoverTile.x === tile.x && hoverTile.y === tile.y) return
      hoverTile = { x: tile.x, y: tile.y }
      if (!pinned) applyView()
      return
    }
    // Buildings, ports, splitters and producers all place on a single tile — preview a footprint rect.
    if (
      item.kind === 'building' ||
      item.kind === 'port' ||
      item.kind === 'splitter' ||
      item.kind === 'producer'
    ) {
      renderer.setGhost({
        kind: 'rect',
        x: tile.x,
        y: tile.y,
        w: item.w,
        h: item.h,
        color: item.color,
      })
      return
    }
    // Belt: until a drag begins, preview the single start tile under the cursor.
    if (!beltStart) {
      renderer.setGhost({ kind: 'rect', x: tile.x, y: tile.y, w: 1, h: 1, color: item.color })
    }
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
      enqueuePlaceBuilding(world, { x: tile.x, y: tile.y, w: item.w, h: item.h, color: item.color })
      registry.record(tile.x, tile.y, { name: item.name, type: 'building' })
      return
    }
    // Port: drops onto the belt tile under the cursor (ignored if there's no belt there).
    if (item.kind === 'port' && item.port) {
      enqueuePlacePort(world, {
        x: tile.x,
        y: tile.y,
        port: item.port,
        color: item.color,
        itemColor: item.itemColor,
        spawnEvery: item.spawnEvery,
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
    // Producer (farm/orchard): drops onto the belt tile under the cursor (ignored off-belt).
    if (item.kind === 'producer') {
      enqueuePlaceProducer(world, {
        x: tile.x,
        y: tile.y,
        color: item.color,
        itemColor: item.itemColor,
        produceEvery: item.produceEvery,
        storageCap: item.storage,
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

  // Selecting a tool enters build mode (drop any inspection); deselecting returns to inspect.
  buildStore.subscribe(() => {
    if (buildStore.selectedItem()) {
      renderer.setGhost(null)
      clearInspect()
    } else {
      applyView()
    }
  })

  return { refresh: applyView }
}
