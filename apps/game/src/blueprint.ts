/**
 * Blueprints: a portable, offsettable capture of a rectangular region of the factory. A blueprint
 * is what the copy-paste clipboard holds and what the persistent library stores — a flat list of
 * relative {@link BlueprintEntry} records mirroring the base game's placement commands minus their
 * absolute coordinates. It carries *structure and configuration* only (belt facing/speed, port
 * facing, a crafter's chosen recipe); stockpile contents are never captured, matching Factorio.
 *
 * Everything here is a pure function of sim state — {@link captureBlueprint} reads the belt grid,
 * building store and (for names) the inspect registry but never mutates them, and the paste helpers
 * ({@link blueprintPlacements}, {@link blueprintGhostCells}) are pure transforms. Actually issuing
 * the placement commands stays in `placement.ts` through the existing `enqueue*` bridge, so paste is
 * just the normal command path re-run at an offset — the sim stays authoritative and deterministic.
 */
import type { GameWorld } from '@factory/engine/core'
import {
  KIND_OUTPUT,
  KIND_INPUT,
  KIND_SPLITTER,
  MAX_SLOTS,
  ROLE_DEPOSIT,
  ROLE_DRAIN,
  buildingAt,
  type GameState,
  type CraftFlow,
  type AcceptSlot,
} from './gameLogic.ts'
import type { InspectRegistry } from './inspect.ts'

/** An axis-aligned tile rectangle (inclusive of both corners). */
export interface Rect {
  readonly x0: number
  readonly y0: number
  readonly x1: number
  readonly y1: number
}

/** Normalize a two-corner drag into a {@link Rect} with x0<=x1, y0<=y1. */
export function normalizeRect(ax: number, ay: number, bx: number, by: number): Rect {
  return {
    x0: Math.min(ax, bx),
    y0: Math.min(ay, by),
    x1: Math.max(ax, bx),
    y1: Math.max(ay, by),
  }
}

/**
 * One captured object, positioned relative to the blueprint's top-left origin (dx, dy). A
 * discriminated union mirroring the `place_*` commands: belts carry their forced facing (so a
 * length-1 paste keeps its direction), ports their facing + drain cadence, crafters their recipe.
 * `name` is the source object's inspector name, replayed on paste so pasted objects read the same.
 */
export type BlueprintEntry =
  | {
      readonly kind: 'belt'
      readonly dx: number
      readonly dy: number
      readonly face: number
      readonly color: number
      readonly moveEvery: number
      readonly name?: string
    }
  | {
      readonly kind: 'port'
      readonly dx: number
      readonly dy: number
      readonly port: 'input' | 'output'
      readonly dir: number
      readonly color: number
      readonly spawnEvery: number
      readonly name?: string
    }
  | {
      readonly kind: 'splitter'
      readonly dx: number
      readonly dy: number
      readonly color: number
      readonly name?: string
    }
  | {
      readonly kind: 'building'
      readonly dx: number
      readonly dy: number
      readonly w: number
      readonly h: number
      readonly color: number
      readonly accepts: readonly AcceptSlot[]
      readonly researchLab?: boolean
      readonly name?: string
    }
  | {
      readonly kind: 'crafter'
      readonly dx: number
      readonly dy: number
      readonly w: number
      readonly h: number
      readonly color: number
      readonly recipe: number
      readonly inputs: readonly CraftFlow[]
      readonly outputs: readonly CraftFlow[]
      readonly craftEvery: number
      readonly storageCap: number
      readonly name?: string
    }

/** A captured region: its footprint size in tiles and the relative entries inside it. */
export interface Blueprint {
  readonly w: number
  readonly h: number
  readonly entries: readonly BlueprintEntry[]
}

/** Whether (x, y) lies within the (inclusive) rectangle. */
function inRect(r: Rect, x: number, y: number): boolean {
  return x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1
}

/** Anchor tile of the lab covering (x, y), or false — used to flag a captured store as a research lab. */
function isLabAnchor(state: GameState, x: number, y: number): boolean {
  const r = state.research
  for (let i = 0; i < r.labCount; i++) if (r.lx[i]! === x && r.ly[i]! === y) return true
  return false
}

/**
 * Capture the region `r` of the live sim as a {@link Blueprint}. Every belt-grid tile inside the
 * rect becomes a `belt` entry (plus a `port`/`splitter` overlay for a non-plain tile); every
 * building whose *anchor* tile lies inside becomes a `crafter` (recipe + I/O read off its slots) or
 * a plain `building` (accept slots). Stockpile counts are intentionally dropped. Reads sim state
 * only — never mutates it, so it cannot affect determinism.
 */
export function captureBlueprint(
  state: GameState,
  world: GameWorld,
  registry: InspectRegistry,
  r: Rect,
): Blueprint {
  const g = state.grid
  const store = state.buildings
  const { Renderable } = world.components
  const entries: BlueprintEntry[] = []

  // Belt layer: each grid tile in the rect, plus its port/splitter overlay when non-plain.
  for (let t = 0; t < g.count; t++) {
    const x = g.tx[t]!
    const y = g.ty[t]!
    if (!inRect(r, x, y)) continue
    const dx = x - r.x0
    const dy = y - r.y0
    const color = Renderable.color[g.trackEid[t]!] ?? 0xffffff
    const name = registry.get(x, y)?.name
    entries.push({
      kind: 'belt',
      dx,
      dy,
      face: g.face[t]!,
      color,
      moveEvery: g.period[t]!,
      ...(name ? { name } : {}),
    })
    const kind = g.kind[t]!
    const markColor = g.markEid[t]! >= 0 ? (Renderable.color[g.markEid[t]!] ?? color) : color
    if (kind === KIND_OUTPUT || kind === KIND_INPUT) {
      entries.push({
        kind: 'port',
        dx,
        dy,
        port: kind === KIND_OUTPUT ? 'output' : 'input',
        dir: g.face[t]!,
        color: markColor,
        spawnEvery: g.portEvery[t]!,
        ...(name ? { name } : {}),
      })
    } else if (kind === KIND_SPLITTER) {
      entries.push({ kind: 'splitter', dx, dy, color: markColor, ...(name ? { name } : {}) })
    }
  }

  // Building layer: capture a building once, when its anchor (top-left) falls in the rect.
  for (let b = 0; b < store.count; b++) {
    const x = store.bx[b]!
    const y = store.by[b]!
    if (!inRect(r, x, y)) continue
    // A building's anchor may repeat in tileIndex, but bx/by is unique per building id — skip
    // stray covers by confirming this id owns the anchor tile.
    if (buildingAt(store, x, y) !== b) continue
    const dx = x - r.x0
    const dy = y - r.y0
    const color = Renderable.color[store.eid[b]!] ?? 0xffffff
    const name = registry.get(x, y)?.name
    const w = store.bw[b]!
    const h = store.bh[b]!
    if (store.crafts[b]) {
      const inputs: CraftFlow[] = []
      const outputs: CraftFlow[] = []
      let storageCap = 0
      const n = store.slotN[b]!
      for (let k = 0; k < n; k++) {
        const si = b * MAX_SLOTS + k
        const role = store.slotRole[si]!
        const amt = store.slotAmt[si]!
        storageCap = Math.max(storageCap, store.slotCap[si]!)
        // A recipe slot is input if it can be deposited into, output if drain-only.
        if (role & ROLE_DEPOSIT) inputs.push({ color: store.slotColor[si]!, amount: amt })
        else if (role & ROLE_DRAIN) outputs.push({ color: store.slotColor[si]!, amount: amt })
      }
      entries.push({
        kind: 'crafter',
        dx,
        dy,
        w,
        h,
        color,
        recipe: store.recipe[b]!,
        inputs,
        outputs,
        craftEvery: store.craftEvery[b]!,
        storageCap,
        ...(name ? { name } : {}),
      })
    } else {
      const accepts: AcceptSlot[] = []
      const n = store.slotN[b]!
      for (let k = 0; k < n; k++) {
        const si = b * MAX_SLOTS + k
        accepts.push({ color: store.slotColor[si]!, cap: store.slotCap[si]! })
      }
      entries.push({
        kind: 'building',
        dx,
        dy,
        w,
        h,
        color,
        accepts,
        ...(isLabAnchor(state, x, y) ? { researchLab: true } : {}),
        ...(name ? { name } : {}),
      })
    }
  }

  return { w: r.x1 - r.x0 + 1, h: r.y1 - r.y0 + 1, entries }
}

/**
 * One concrete placement to enqueue: a blueprint entry resolved to absolute coordinates. The union
 * mirrors the `enqueue*` argument shapes so `placement.ts` can dispatch each straight to its bridge
 * helper. Pure output of {@link blueprintPlacements}.
 */
export type Placement =
  | {
      readonly kind: 'belt'
      readonly ax: number
      readonly ay: number
      readonly bx: number
      readonly by: number
      readonly face: number
      readonly color: number
      readonly moveEvery: number
      readonly name?: string
    }
  | {
      readonly kind: 'port'
      readonly x: number
      readonly y: number
      readonly port: 'input' | 'output'
      readonly dir: number
      readonly color: number
      readonly spawnEvery: number
      readonly name?: string
    }
  | {
      readonly kind: 'splitter'
      readonly x: number
      readonly y: number
      readonly color: number
      readonly name?: string
    }
  | {
      readonly kind: 'building'
      readonly x: number
      readonly y: number
      readonly w: number
      readonly h: number
      readonly color: number
      readonly accepts: readonly AcceptSlot[]
      readonly researchLab?: boolean
      readonly name?: string
    }
  | {
      readonly kind: 'crafter'
      readonly x: number
      readonly y: number
      readonly w: number
      readonly h: number
      readonly color: number
      readonly recipe: number
      readonly inputs: readonly CraftFlow[]
      readonly outputs: readonly CraftFlow[]
      readonly craftEvery: number
      readonly storageCap: number
      readonly name?: string
    }

/**
 * Resolve a blueprint's entries to absolute {@link Placement}s with its top-left origin at
 * (originX, originY). Pure — the offset is just `origin + (dx, dy)`. Belts become length-1 runs
 * carrying their forced `face`.
 */
export function blueprintPlacements(bp: Blueprint, originX: number, originY: number): Placement[] {
  const out: Placement[] = []
  for (const e of bp.entries) {
    const x = originX + e.dx
    const y = originY + e.dy
    switch (e.kind) {
      case 'belt':
        out.push({
          kind: 'belt',
          ax: x,
          ay: y,
          bx: x,
          by: y,
          face: e.face,
          color: e.color,
          moveEvery: e.moveEvery,
          ...(e.name ? { name: e.name } : {}),
        })
        break
      case 'port':
        out.push({
          kind: 'port',
          x,
          y,
          port: e.port,
          dir: e.dir,
          color: e.color,
          spawnEvery: e.spawnEvery,
          ...(e.name ? { name: e.name } : {}),
        })
        break
      case 'splitter':
        out.push({ kind: 'splitter', x, y, color: e.color, ...(e.name ? { name: e.name } : {}) })
        break
      case 'building':
        out.push({
          kind: 'building',
          x,
          y,
          w: e.w,
          h: e.h,
          color: e.color,
          accepts: e.accepts,
          ...(e.researchLab ? { researchLab: true } : {}),
          ...(e.name ? { name: e.name } : {}),
        })
        break
      case 'crafter':
        out.push({
          kind: 'crafter',
          x,
          y,
          w: e.w,
          h: e.h,
          color: e.color,
          recipe: e.recipe,
          inputs: e.inputs,
          outputs: e.outputs,
          craftEvery: e.craftEvery,
          storageCap: e.storageCap,
          ...(e.name ? { name: e.name } : {}),
        })
        break
    }
  }
  return out
}

/** A translucent preview cell for the paste ghost: a footprint rect, tinted, with an optional port arrow. */
export interface GhostCell {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly color: number
  readonly dir?: number
}

/**
 * The paste-preview cells for a blueprint stamped with its top-left at (originX, originY). Pure. A
 * port cell carries its `dir` so the ghost draws its arrow; belts/splitters are plain 1×1 rects and
 * buildings/crafters their footprint.
 */
export function blueprintGhostCells(bp: Blueprint, originX: number, originY: number): GhostCell[] {
  const cells: GhostCell[] = []
  for (const e of bp.entries) {
    const x = originX + e.dx
    const y = originY + e.dy
    if (e.kind === 'port') cells.push({ x, y, w: 1, h: 1, color: e.color, dir: e.dir })
    else if (e.kind === 'belt' || e.kind === 'splitter')
      cells.push({ x, y, w: 1, h: 1, color: e.color })
    else cells.push({ x, y, w: e.w, h: e.h, color: e.color })
  }
  return cells
}

/** Serialize a blueprint to a compact JSON string for `localStorage`. */
export function serializeBlueprint(bp: Blueprint): string {
  return JSON.stringify(bp)
}

/**
 * Parse a blueprint from its serialized form, or `null` if the text is malformed (corrupt or
 * hand-edited `localStorage`). Validates the outer shape and that `entries` is an array; entry
 * fields are trusted (they were produced by {@link serializeBlueprint}).
 */
export function parseBlueprint(text: string): Blueprint | null {
  try {
    const v = JSON.parse(text) as unknown
    if (!v || typeof v !== 'object') return null
    const o = v as { w?: unknown; h?: unknown; entries?: unknown }
    if (typeof o.w !== 'number' || typeof o.h !== 'number' || !Array.isArray(o.entries)) return null
    return { w: o.w, h: o.h, entries: o.entries as BlueprintEntry[] }
  } catch {
    return null
  }
}
