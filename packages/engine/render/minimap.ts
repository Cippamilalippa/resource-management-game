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
