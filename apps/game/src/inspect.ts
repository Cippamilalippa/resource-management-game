/**
 * Read-only world inspector: given a hovered tile, work out *what* is there and produce a
 * compact, declarative description the sidebar renders. It reads sim state only (the belt
 * grid and the entity component arrays) and never mutates the world, so it cannot affect
 * determinism. Resolution runs off the hot path — only when the hovered tile changes or on
 * the overlay's throttled refresh — so the per-tile linear entity scan is fine.
 *
 * Naming: the sim arrays carry no human-readable names (the engine is game-agnostic), so a
 * tiny tile-keyed {@link InspectRegistry} remembers the prototype name placed at each tile.
 * Everything else (facing, speed, throughput, the carried item, storage) is read live from
 * the authoritative grid/entity state.
 */
import { DEFAULT_TICK_RATE, renderableEntities, type GameWorld } from '@factory/engine/core'
import {
  KIND_OUTPUT,
  KIND_INPUT,
  KIND_SPLITTER,
  MAX_SLOTS,
  ROLE_DRAIN,
  buildingAt,
  tileKey,
  villageStageAt,
  type BeltGrid,
  type BuildingStore,
  type VillageStore,
} from './gameLogic.ts'

/** Compass names for a direction index 0..3 (N, E, S, W). */
const DIR_NAMES = ['North', 'East', 'South', 'West'] as const

/** A single declarative info row. The sidebar renders each kind generically. */
export type InspectStat =
  | { readonly kind: 'text'; readonly label: string; readonly value: string }
  | { readonly kind: 'color'; readonly label: string; readonly color: number }
  | {
      readonly kind: 'bar'
      readonly label: string
      readonly value: number
      readonly max: number
      /** Optional fill colour — used to tint a stockpile bar by its resource. */
      readonly color?: number
    }

/** The resolved description of whatever sits under the cursor. */
export interface InspectInfo {
  /** Display name (e.g. "Conveyor Belt Mk2"). */
  readonly title: string
  /** Short category line (e.g. "Conveyor belt · facing East"). */
  readonly subtitle: string
  /** Accent colour — the object's footprint colour. */
  readonly color: number
  /** Footprint in tiles; drives the world-space highlight. */
  readonly footprint: {
    readonly x: number
    readonly y: number
    readonly w: number
    readonly h: number
  }
  /** Declarative info rows. */
  readonly stats: readonly InspectStat[]
}

/** Name + prototype type remembered for the object placed at a tile. */
export interface InspectMeta {
  readonly name: string
  /** Prototype `type` ('building' | 'belt' | 'output' | 'terrain' | …); drives the subtitle. */
  readonly type: string
  /** Optional human blurb (e.g. a terrain's `info`), shown as an extra inspector row. */
  readonly detail?: string
}

/**
 * Tile-keyed memory of placed-object names. The sim does not store names, so placement
 * (and the initial scene) record them here for the inspector to read back. Keyed by the
 * object's anchor tile: each belt-grid tile, or a building's top-left tile.
 */
export class InspectRegistry {
  readonly #byTile = new Map<number, InspectMeta>()

  record(x: number, y: number, meta: InspectMeta): void {
    this.#byTile.set(tileKey(x, y), meta)
  }

  get(x: number, y: number): InspectMeta | undefined {
    return this.#byTile.get(tileKey(x, y))
  }
}

/** Format a per-N-ticks cadence as a human "/s" rate (e.g. 30 ticks → "2 /s"). */
function perSec(everyTicks: number): string {
  if (everyTicks <= 0) return '—'
  const rate = DEFAULT_TICK_RATE / everyTicks
  return `${rate >= 10 ? Math.round(rate) : Number(rate.toFixed(2))} /s`
}

/** Generic fall-back name for a belt-grid tile of the given kind. */
function beltKindName(kind: number): string {
  switch (kind) {
    case KIND_OUTPUT:
      return 'Output port'
    case KIND_INPUT:
      return 'Input port'
    case KIND_SPLITTER:
      return 'Splitter'
    default:
      return 'Conveyor belt'
  }
}

/** The "Carrying" row for a belt tile: the riding item's colour, or "—" when empty. */
function carryingStat(world: GameWorld, slot: number): InspectStat {
  if (slot < 0) return { kind: 'text', label: 'Carrying', value: '—' }
  return { kind: 'color', label: 'Carrying', color: world.components.Renderable.color[slot]! }
}

/** Human name of the building a port is linked to, read back from the inspect registry. */
function linkedName(
  grid: BeltGrid,
  buildings: BuildingStore,
  registry: InspectRegistry,
  t: number,
): string {
  const b = grid.portBuilding[t]!
  if (b < 0) return 'Not linked'
  return registry.get(buildings.bx[b]!, buildings.by[b]!)?.name ?? 'building'
}

/** Build the description for the belt-grid tile `t` at (x, y). */
function describeBeltTile(
  world: GameWorld,
  grid: BeltGrid,
  buildings: BuildingStore,
  registry: InspectRegistry,
  t: number,
  x: number,
  y: number,
): InspectInfo {
  const kind = grid.kind[t]!
  const face = grid.face[t]!
  const meta = registry.get(x, y)
  const title = meta?.name ?? beltKindName(kind)
  const color = world.components.Renderable.color[grid.trackEid[t]!] ?? 0xffffff
  const facing = `facing ${DIR_NAMES[face] ?? '—'}`

  const stats: InspectStat[] = []
  switch (kind) {
    case KIND_OUTPUT:
      stats.push(
        { kind: 'text', label: 'Output rate', value: perSec(grid.portEvery[t]!) },
        { kind: 'text', label: 'Drains', value: linkedName(grid, buildings, registry, t) },
        { kind: 'text', label: 'Facing', value: DIR_NAMES[face] ?? '—' },
        carryingStat(world, grid.slot[t]!),
      )
      return {
        title,
        subtitle: `Output port · ${facing}`,
        color,
        footprint: { x, y, w: 1, h: 1 },
        stats,
      }
    case KIND_INPUT:
      stats.push(
        { kind: 'text', label: 'Feeds', value: linkedName(grid, buildings, registry, t) },
        { kind: 'text', label: 'Facing', value: DIR_NAMES[face] ?? '—' },
        carryingStat(world, grid.slot[t]!),
      )
      return {
        title,
        subtitle: `Input port · ${facing}`,
        color,
        footprint: { x, y, w: 1, h: 1 },
        stats,
      }
    case KIND_SPLITTER:
      stats.push(
        { kind: 'text', label: 'Routes', value: 'round-robin to neighbours' },
        carryingStat(world, grid.slot[t]!),
      )
      return {
        title,
        subtitle: `Splitter · ${facing}`,
        color,
        footprint: { x, y, w: 1, h: 1 },
        stats,
      }
    default: {
      // Plain belt: speed in tiles/sec from the tile's move period.
      const period = grid.period[t]!
      const speed = period > 0 ? `${Number((DEFAULT_TICK_RATE / period).toFixed(2))} tiles/s` : '—'
      stats.push(
        { kind: 'text', label: 'Speed', value: speed },
        { kind: 'text', label: 'Facing', value: DIR_NAMES[face] ?? '—' },
        carryingStat(world, grid.slot[t]!),
      )
      return {
        title,
        subtitle: `Conveyor belt · ${facing}`,
        color,
        footprint: { x, y, w: 1, h: 1 },
        stats,
      }
    }
  }
}

/** Human subtitle for a building/scenery entity given its prototype type. */
function buildingSubtitle(type: string | undefined): string {
  switch (type) {
    case 'building':
      return 'Building'
    case 'resource':
      return 'Resource'
    case 'terrain':
      return 'Terrain'
    case undefined:
      return 'Object'
    default:
      return type.charAt(0).toUpperCase() + type.slice(1)
  }
}

/**
 * Find a non-belt entity whose footprint covers (x, y) and describe it. Only reached when
 * the tile is not a belt-grid tile, so belt tracks and riding items (always on grid tiles)
 * are never matched here.
 */
function describeBuilding(
  world: GameWorld,
  buildings: BuildingStore,
  villages: VillageStore,
  registry: InspectRegistry,
  x: number,
  y: number,
): InspectInfo | null {
  const { Position, Renderable } = world.components
  const ents = renderableEntities(world)
  for (let i = 0; i < ents.length; i++) {
    const eid = ents[i]!
    const w = Renderable.width[eid]!
    const h = Renderable.height[eid]!
    const px = Position.x[eid]!
    const py = Position.y[eid]!
    if (x < px || x >= px + w || y < py || y >= py + h) continue
    const meta = registry.get(px, py)
    const stats: InspectStat[] = []
    // A terrain (or any object) blurb leads the rows, e.g. "build a Farm on top".
    if (meta?.detail) stats.push({ kind: 'text', label: 'Use', value: meta.detail })
    // A resource-holding building shows its production and a bar per stockpiled resource.
    const b = buildingAt(buildings, px, py)
    if (b >= 0) {
      if (buildings.crafts[b]) {
        // The crafted resource is the first drain (output) slot's colour.
        let outColor = -1
        const slots = buildings.slotN[b]!
        for (let k = 0; k < slots; k++) {
          const si = b * MAX_SLOTS + k
          if (buildings.slotRole[si]! & ROLE_DRAIN && buildings.slotAmt[si]! > 0) {
            outColor = buildings.slotColor[si]!
            break
          }
        }
        stats.push({ kind: 'text', label: 'Produces', value: perSec(buildings.craftEvery[b]!) })
        if (outColor >= 0) stats.push({ kind: 'color', label: 'Resource', color: outColor })
      }
      // A village shows its current level and population (read-only, one-way).
      const vs = villageStageAt(villages, px, py)
      if (vs >= 0) {
        stats.push({ kind: 'text', label: 'Level', value: String(vs + 1) })
        const pop = villages.stages[vs]?.population
        if (typeof pop === 'number')
          stats.push({ kind: 'text', label: 'Population', value: String(pop) })
      }
      const n = buildings.slotN[b]!
      for (let k = 0; k < n; k++) {
        const si = b * MAX_SLOTS + k
        stats.push({
          kind: 'bar',
          label: 'Stock',
          value: buildings.slotCount[si]!,
          max: buildings.slotCap[si]!,
          color: buildings.slotColor[si]!,
        })
      }
    }
    stats.push(
      { kind: 'text', label: 'Size', value: `${w}×${h}` },
      { kind: 'text', label: 'Tiles', value: String(w * h) },
      { kind: 'text', label: 'Position', value: `${px}, ${py}` },
    )
    return {
      title: meta?.name ?? 'Structure',
      subtitle: buildingSubtitle(meta?.type),
      color: Renderable.color[eid]!,
      footprint: { x: px, y: py, w, h },
      stats,
    }
  }
  return null
}

/**
 * Resolve whatever sits under tile (x, y): a belt-grid tile first (authoritative for
 * belts/ports/splitters/producers), otherwise a building/scenery entity covering it, or
 * `null` for empty ground. Read-only.
 */
export function resolveInspect(
  world: GameWorld,
  grid: BeltGrid,
  buildings: BuildingStore,
  villages: VillageStore,
  registry: InspectRegistry,
  x: number,
  y: number,
): InspectInfo | null {
  const t = grid.index.get(tileKey(x, y))
  if (t !== undefined) return describeBeltTile(world, grid, buildings, registry, t, x, y)
  return describeBuilding(world, buildings, villages, registry, x, y)
}
