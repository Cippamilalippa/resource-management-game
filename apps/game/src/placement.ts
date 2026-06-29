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
} from './gameLogic.ts'
import { buildStore } from './buildStore.ts'

/**
 * Wire the renderer's pointer gesture hooks to the build store and the sim command
 * queue. A building places on a single click; a belt is drawn by dragging from its
 * start tile to its end tile and releasing. Nothing here writes sim state directly —
 * gestures enqueue commands the sim applies at the next tick, preserving determinism
 * and the render-is-read-only invariant.
 */
export function installPlacement(renderer: Renderer, world: GameWorld): void {
  // The belt's start tile while a drag is in progress (belts only); null otherwise.
  let beltStart: GridCoord | null = null

  renderer.onTileHover = (tile) => {
    const item = buildStore.selectedItem()
    if (!item) {
      renderer.setGhost(null)
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
      beltStart = null
      return
    }
    if (item.kind === 'building') {
      enqueuePlaceBuilding(world, { x: tile.x, y: tile.y, w: item.w, h: item.h, color: item.color })
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
      return
    }
    // Splitter: also drops onto the belt tile under the cursor (ignored off-belt).
    if (item.kind === 'splitter') {
      enqueuePlaceSplitter(world, { x: tile.x, y: tile.y, color: item.color })
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
  }

  // Clear the preview when the player deselects the current tool.
  buildStore.subscribe(() => {
    if (!buildStore.selectedItem()) renderer.setGhost(null)
  })
}
