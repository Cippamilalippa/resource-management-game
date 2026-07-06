import { clamp } from '@factory/shared'

/** An axis-aligned rectangle in screen pixels (viewport space). */
export interface MinimapRect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** An axis-aligned bounds in world-pixel space (pre-camera-transform). */
export interface WorldBounds {
  readonly minX: number
  readonly minY: number
  readonly maxX: number
  readonly maxY: number
}

/** Placement knobs for the minimap panel. */
export interface MinimapConfig {
  /** Longest edge of the panel, in screen px. */
  readonly size: number
  /** Gap between the panel and the viewport corner, in screen px. */
  readonly margin: number
}

/**
 * The minimap panel rectangle, pinned to the bottom-right corner of the viewport. A square of
 * `size`, kept `margin` px clear of the edges — clamped so it never overflows a small viewport.
 * Pure geometry; the renderer draws whatever this returns.
 */
export function minimapPanel(viewW: number, viewH: number, cfg: MinimapConfig): MinimapRect {
  const w = Math.min(cfg.size, Math.max(0, viewW - cfg.margin * 2))
  const h = Math.min(cfg.size, Math.max(0, viewH - cfg.margin * 2))
  return { x: viewW - cfg.margin - w, y: viewH - cfg.margin - h, w, h }
}

/**
 * The uniform (aspect-preserving) fit of `world` bounds into `panel`: the scale, and the
 * top-left of the letterboxed content once centred. Both projection directions and the drawing
 * share this one transform so a plotted point and a clicked point always agree.
 */
export function minimapFit(
  world: WorldBounds,
  panel: MinimapRect,
): { scale: number; contentX: number; contentY: number } {
  const worldW = Math.max(world.maxX - world.minX, 1)
  const worldH = Math.max(world.maxY - world.minY, 1)
  const scale = Math.min(panel.w / worldW, panel.h / worldH)
  const contentX = panel.x + (panel.w - worldW * scale) / 2
  const contentY = panel.y + (panel.h - worldH * scale) / 2
  return { scale, contentX, contentY }
}

/** Project a world-pixel point into panel-space (screen px). Inverse of {@link minimapToWorld}. */
export function projectToMinimap(
  wx: number,
  wy: number,
  world: WorldBounds,
  panel: MinimapRect,
): { x: number; y: number } {
  const { scale, contentX, contentY } = minimapFit(world, panel)
  return { x: contentX + (wx - world.minX) * scale, y: contentY + (wy - world.minY) * scale }
}

/**
 * Map a panel-space point (screen px, e.g. a click on the minimap) back to a world-pixel point,
 * clamped to the world bounds so a click in the letterbox margin still lands on the map. Inverse
 * of {@link projectToMinimap}.
 */
export function minimapToWorld(
  px: number,
  py: number,
  world: WorldBounds,
  panel: MinimapRect,
): { x: number; y: number } {
  const { scale, contentX, contentY } = minimapFit(world, panel)
  return {
    x: clamp(world.minX + (px - contentX) / scale, world.minX, world.maxX),
    y: clamp(world.minY + (py - contentY) / scale, world.minY, world.maxY),
  }
}

/** Whether a screen-space point falls inside the panel rectangle. */
export function inMinimap(px: number, py: number, panel: MinimapRect): boolean {
  return px >= panel.x && px <= panel.x + panel.w && py >= panel.y && py <= panel.y + panel.h
}

/** Grow bounds by `pad` world px on every side (breathing room around the plotted content). */
export function padBounds(b: WorldBounds, pad: number): WorldBounds {
  return { minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad }
}

/**
 * A focus+zoom view of the world for the full-screen map (Factorio's M). `focusX/focusY` is the
 * world-pixel point shown at the panel centre; `zoom` multiplies the aspect-fit base scale. It is
 * wholly independent of the world camera — panning/zooming the map never moves the camera, so
 * leaving map mode returns the player exactly where they were. Pure data; the renderer draws it.
 */
export interface MapView {
  readonly focusX: number
  readonly focusY: number
  readonly zoom: number
}

/**
 * The aspect-fit base scale (world-px → screen-px at zoom 1) of `world` into `panel` — the same
 * uniform fit {@link minimapFit} computes, exposed on its own for the map's focus+zoom projection.
 */
export function mapBaseScale(world: WorldBounds, panel: MinimapRect): number {
  return minimapFit(world, panel).scale
}

/** The effective world-px → screen-px scale of a map view: the aspect-fit base times the map zoom. */
export function mapScale(world: WorldBounds, panel: MinimapRect, view: MapView): number {
  return mapBaseScale(world, panel) * view.zoom
}

/**
 * Project a world-pixel point into panel-space (screen px) for a focus+zoom map view: the focus
 * point lands at the panel centre and everything scales around it. Inverse of {@link mapToWorld}.
 */
export function projectToMap(
  wx: number,
  wy: number,
  world: WorldBounds,
  panel: MinimapRect,
  view: MapView,
): { x: number; y: number } {
  const s = mapScale(world, panel, view)
  const cx = panel.x + panel.w / 2
  const cy = panel.y + panel.h / 2
  return { x: cx + (wx - view.focusX) * s, y: cy + (wy - view.focusY) * s }
}

/**
 * Map a panel-space point (screen px, e.g. a click or the cursor) back to a world-pixel point for a
 * focus+zoom map view. Unlike {@link minimapToWorld} it is NOT clamped to the world bounds — the map
 * can pan and zoom freely past the plotted content. Inverse of {@link projectToMap}.
 */
export function mapToWorld(
  px: number,
  py: number,
  world: WorldBounds,
  panel: MinimapRect,
  view: MapView,
): { x: number; y: number } {
  const s = mapScale(world, panel, view)
  const cx = panel.x + panel.w / 2
  const cy = panel.y + panel.h / 2
  return { x: view.focusX + (px - cx) / s, y: view.focusY + (py - cy) / s }
}

/**
 * Re-zoom a map view by `factor` about the screen point (px, py), keeping the world point currently
 * under it fixed (so the map zooms around the cursor) — the map analogue of {@link Camera.zoomTo}.
 * `zoom` is clamped to [minZoom, maxZoom]; the focus is shifted to hold the anchor point. Returns the
 * adjusted view (pure — the caller stores it).
 */
export function zoomMapAround(
  px: number,
  py: number,
  world: WorldBounds,
  panel: MinimapRect,
  view: MapView,
  factor: number,
  minZoom: number,
  maxZoom: number,
): MapView {
  const zoom = clamp(view.zoom * factor, minZoom, maxZoom)
  const next: MapView = { focusX: view.focusX, focusY: view.focusY, zoom }
  // The anchor's world point before and after the zoom (about the unchanged focus); shift the focus
  // by their difference so the anchor maps back to the same world point under the new zoom.
  const before = mapToWorld(px, py, world, panel, view)
  const after = mapToWorld(px, py, world, panel, next)
  return {
    focusX: view.focusX + (before.x - after.x),
    focusY: view.focusY + (before.y - after.y),
    zoom,
  }
}
