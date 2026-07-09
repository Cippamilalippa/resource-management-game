/**
 * Base-game ("mod zero") sim logic: conveyor belts, the buildings that hold resource
 * stockpiles, the input/output ports that bridge those buildings to the belts, the
 * splitters that fan items out at junctions, the command handlers that turn player intents
 * into sim state, and the systems that drive them.
 *
 * This is the SINGLE source of truth for the base game's simulation — both hosts (the
 * headless runner and the Electron renderer) run it as `mods/base`, discovered and loaded
 * by the same /mods scan a third-party mod uses. It reaches the engine ONLY through the
 * stable {@link ModApi} (`api.spawn`/`api.despawn`, plus the live world for reads) — never
 * via engine internals — so whatever the base game can do, a modder can too. The UI→sim
 * command bridge (`enqueuePlace*`) lives in `commands.ts`, separate from this sandboxed sim.
 *
 * A belt is a grid of directed tiles. Each tile faces one of four directions and, on a
 * move-cycle, hands the item riding it to the neighbour tile it faces — but only if that
 * neighbour is itself a belt tile and is (or is becoming) empty, so items back up behind
 * anything ahead of them.
 *
 * Resources live in *buildings*, not on the belt: a building owns an internal stockpile of
 * one or more resources (each capped). A *crafter* building runs a recipe, consuming its input
 * slots and producing into its output slots every N ticks (an extraction recipe has no inputs,
 * so it just makes a resource from nothing but time + terrain). Belts reach a building through
 * two belt-tile modifiers
 * linked to an orthogonally adjacent building: an *output* port drains a resource out of the
 * building onto its own tile every N ticks; an *input* port deposits an arriving item into
 * the building — but only if the building accepts that resource (else the item backs up). Each
 * port carries a facing arrow that picks *which* bordering building it bridges: an output's
 * arrow points *away* from the building it drains (the arrow starts on the building); an
 * input's arrow points *into* the building it feeds. So a port tile flanked by two buildings
 * binds to exactly the one its arrow designates — the other side is ignored. A
 * *splitter* tile round-robins its arriving item across every adjacent belt tile except the
 * one it came from, skipping any that are full. The resource an item carries is identified by
 * its colour.
 *
 * Everything is integer-grid and tick-driven, so identical inputs produce byte-identical
 * state. The belt grid and the building store keep their data in flat Structure-of-Arrays
 * buffers grown only at placement time; the per-tick update never allocates (bar the
 * occasional item spawn).
 */
import type { GameWorld, System } from '@factory/engine/core'
import type { ModApi } from '@factory/engine/scripting'

// --- Belt grid --------------------------------------------------------------

/**
 * Per-tile feature stored in {@link BeltGrid.kind}. Exported so the (read-only) UI
 * inspector can interpret a hovered belt tile; the sim itself uses them internally.
 */
export const KIND_PLAIN = 0
export const KIND_OUTPUT = 1
export const KIND_INPUT = 2
export const KIND_SPLITTER = 3
/**
 * Underground-belt caps. An *entrance* ({@link KIND_UNDER_IN}) swallows the item riding it and, in a
 * single move-cycle, hands it to its paired *exit* ({@link KIND_UNDER_OUT}) up to
 * {@link UNDERGROUND_MAX_SPAN} tiles ahead along the cap facing — carrying the line under whatever
 * belts/buildings sit in the gap between them without touching them. The pairing is expressed purely
 * through the neighbour table (an entrance's forward neighbour is wired to its exit in
 * {@link rebuildTopology} from {@link BeltGrid.partner}), so the back-pressure in {@link stepBelts}
 * works unchanged: the item only hops when the exit tile is free, and a blocked exit backs the
 * entrance — and the belt behind it — up. The exit feeds its own facing neighbour like any belt tile.
 */
export const KIND_UNDER_IN = 4
export const KIND_UNDER_OUT = 5

/**
 * Maximum tile distance (along the cap facing) an underground tunnel may span, entrance to exit.
 * Exported so the placement UI can clamp the drag and reject an over-long span before enqueuing.
 * A span of 1 is a degenerate adjacent pair; the useful range is 2..N (at least one covered gap tile).
 */
export const UNDERGROUND_MAX_SPAN = 6

/**
 * Per-port colour filter. An output port drains only slots whose colour passes its filter (so a
 * multi-output machine can split its products onto separate belts); an input port only ingests
 * items whose colour passes (others back the belt up, exactly like an unaccepted resource). A port
 * carries up to {@link MAX_PORT_FILTER} colours and a mode: none (default — everything passes),
 * whitelist (only the listed colours) or blacklist (everything except them). Empty slots hold
 * {@link FILTER_EMPTY} so colour 0 (black) is still a distinguishable, filterable colour.
 */
export const FILTER_NONE = 0
export const FILTER_WHITELIST = 1
export const FILTER_BLACKLIST = 2
export const MAX_PORT_FILTER = 4
export const FILTER_EMPTY = -1

/** No item / no neighbour / no link sentinel for the Int32 slot, neighbour and link arrays. */
const NONE = -1

/** Direction indices and their unit steps: 0=N, 1=E, 2=S, 3=W. */
const DX = [0, 1, 0, -1] as const
const DY = [-1, 0, 1, 0] as const

/** The opposite of direction `d` (N<->S, E<->W). */
function opposite(d: number): number {
  return (d + 2) & 3
}

/**
 * Render glyphs encoded into the generic `Renderable.sprite` field as
 * `shape * 4 + orient`. The engine stays game-agnostic (it draws a few primitive
 * shapes); the base game assigns them meaning. orient is a direction index 0..3.
 */
const SHAPE_CIRCLE = 1
const SHAPE_BELT_ARROW = 2
const SHAPE_PORT_ARROW = 3
const SHAPE_SPLITTER = 4
const SHAPE_CRAFTER = 5
const SHAPE_TERRAIN = 6
// Building silhouette variants (drawn by the engine as distinct top-caps; here the base game maps
// its own machine categories onto them so a factory reads apart at a glance). Load-time entity
// classification treats all of these as building footprints (they are none of the special shapes).
const SHAPE_EXTRACTOR = 7
const SHAPE_LAB = 8
const SHAPE_DEPOT = 9
const SHAPE_PRODUCER = 10
const SHAPE_CANNON = 11
// Underground-belt cap glyphs: a down-ramp (entrance, item descends) and an up-ramp (exit, item
// rises), each oriented along the cap facing. Drawn by the engine as two more generic ramp glyphs.
const SHAPE_UNDER_IN = 12
const SHAPE_UNDER_OUT = 13
function sprite(shape: number, orient: number): number {
  return shape * 4 + orient
}

/**
 * Glyph for a terrain tile (the engine draws shape 6 as a flat, full-tile fill). Terrain is
 * a passive background layer placed by the starting scene; it produces nothing on its own
 * but gates which crafters may be built on top (see {@link terrainTypeOf} and the
 * `place_crafter` handler). Exported so the scene spawner can paint terrain patches.
 */
export const TERRAIN_SPRITE = sprite(SHAPE_TERRAIN, 0)

// --- Terrain ----------------------------------------------------------------

/**
 * A passive ground layer mapping a packed tile key (see {@link tileKey}) to a terrain
 * *type* — the deterministic integer {@link terrainTypeOf} derives from a terrain
 * prototype's string id. Terrain never ticks and produces nothing; it exists only to gate
 * placement: a resource producer that declares a `requiresTerrain` may be built only on a
 * tile whose terrain type matches. Populated once by the starting scene.
 */
export type TerrainGrid = Map<number, number>

/** Reserved "no terrain / no requirement" sentinel; {@link terrainTypeOf} never returns it. */
export const TERRAIN_NONE = 0

/**
 * Map a terrain prototype's string id to a stable, non-zero 32-bit integer (FNV-1a). Both
 * the scene (recording terrain into the grid) and placement (tagging a producer with the
 * terrain it needs) hash through here, so the integer the sim compares is derived from the
 * same id on both sides without the sim ever needing the string. Deterministic and
 * allocation-free; `|| 1` keeps {@link TERRAIN_NONE} (0) reserved.
 */
export function terrainTypeOf(id: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0 || 1
}

/** Terrain type at (x, y), or {@link TERRAIN_NONE} if the tile has no terrain. */
export function terrainTypeAt(terrain: TerrainGrid, x: number, y: number): number {
  return terrain.get(tileKey(x, y)) ?? TERRAIN_NONE
}

/**
 * The set of terrain *types* nothing can be built on (impassable biomes like water — any terrain
 * whose prototype declares `blocksBuild`). Derived from the content, so it is NOT serialized; the
 * host recomputes it from the registry each new-game/load via {@link loadBlockingTerrain}, exactly
 * like the price table. Parallel to {@link TerrainGrid}, keyed by the same {@link terrainTypeOf}
 * integer the grid stores, so a placement check is a single hashed lookup.
 */
export type BlockingTerrain = Set<number>

/** Replace the blocking-terrain set from the host-supplied terrain ids (before newGame/load). */
export function loadBlockingTerrain(set: BlockingTerrain, ids: readonly string[]): void {
  set.clear()
  for (const id of ids) set.add(terrainTypeOf(id))
}

/**
 * Whether the tile (x, y) sits on build-blocking terrain (water). Mirrored by the app-side placement
 * ghost so its red "blocked" preview agrees with what the sim rejects. A tile with no terrain, or a
 * cosmetic/deposit terrain, returns false. Reads the world, never mutates it (sim → render, one-way).
 */
export function terrainBlocksBuild(state: GameState, x: number, y: number): boolean {
  return state.blockingTerrain.has(terrainTypeAt(state.terrain, x, y))
}

/**
 * How far beyond its own footprint (in tiles, on every side) a mining extractor reaches. A mine
 * works its footprint expanded by this many tiles: it may be built on OR near a matching deposit and
 * depletes every matching deposit tile inside that area (see {@link extractorAnchorInReach} and
 * {@link runCrafters}). The placement ghost and the hover/selection outline draw this same perimeter,
 * so what a player sees is exactly what the mine covers.
 */
export const EXTRACTOR_REACH = 1

/**
 * Terrain type recorded at packed tile `key`, or {@link TERRAIN_NONE}. The by-key twin of
 * {@link terrainTypeAt}, for a caller already holding a packed key (an extractor's cached anchor).
 */
export function terrainTypeAtKey(terrain: TerrainGrid, key: number): number {
  return terrain.get(key) ?? TERRAIN_NONE
}

/**
 * Packed tile key of the first deposit within an extractor's reach — its footprint at (x, y) sized
 * w×h, expanded by {@link EXTRACTOR_REACH} on every side — whose terrain type satisfies `matches`,
 * scanned row-major (top-left first), or -1 if none is in reach. Shared by the sim's placement gate
 * and the app-side ghost/recipe resolution so both agree on which deposit a mine adopts and covers.
 * Allocation-free bounded scan (coverage is a footprint plus a one-tile ring).
 */
export function extractorAnchorInReach(
  terrain: TerrainGrid,
  x: number,
  y: number,
  w: number,
  h: number,
  matches: (terrainType: number) => boolean,
): number {
  for (let ty = y - EXTRACTOR_REACH; ty < y + h + EXTRACTOR_REACH; ty++) {
    for (let tx = x - EXTRACTOR_REACH; tx < x + w + EXTRACTOR_REACH; tx++) {
      const tt = terrain.get(tileKey(tx, ty))
      if (tt !== undefined && matches(tt)) return tileKey(tx, ty)
    }
  }
  return -1
}

// --- Deposits: finite richness (G1) -----------------------------------------

/**
 * "This deposit tile has no finite richness" sentinel returned by {@link depositRichnessAt} — an
 * infinite / legacy deposit (a scenario that declares richness infinite, or an old save that
 * predates the field). Distinct from {@link RICHNESS_EXHAUSTED} (0, a finite deposit run dry).
 */
export const RICHNESS_INFINITE = -1

/** A finite deposit tile at zero remaining units — EXHAUSTED. Its extraction crafter stalls. */
export const RICHNESS_EXHAUSTED = 0

/**
 * The deterministic colour a deposit's terrain entity is greyed to the moment it exhausts, so the
 * depleted patch reads apart at a glance. The sim owns entity colours (sim → render, one-way), so
 * this is mutated onto the terrain {@link import('@factory/engine/core').Renderable} like any other
 * sim-driven visual; being deterministic, it round-trips through save/load and the state hash.
 */
export const EXHAUSTED_COLOR = 0x35353b

/**
 * Per-tile deposit richness, owned by the base game (not the engine) — the finite counterpart to the
 * infinite extraction the base game shipped with. Parallel to {@link TerrainGrid}: keyed by the same
 * packed tile key, it records how many extraction units remain under a deposit tile.
 *
 *   - **absent** from `remaining` → the tile has *infinite* richness (an `infinite` scenario, or a
 *     legacy save with no deposit data). Extraction never depletes it — the original behaviour.
 *   - **> 0** → a finite deposit with that many units left.
 *   - **0** ({@link RICHNESS_EXHAUSTED}) → drained; its extraction crafter stalls (read as starved).
 *
 * `eid` maps each finite deposit tile to its terrain render entity, so exhaustion can grey that
 * entity in place (see {@link EXHAUSTED_COLOR}). Entity ids are not stable across save/load, so `eid`
 * is never serialized — it is re-linked from the re-spawned terrain entities on load. Populated by
 * the starting scene (richness rolled from the scenario band via the seeded RNG) and drained by
 * {@link runCrafters}; every mutation is a plain Map write, no per-entity allocation.
 */
export interface DepositStore {
  /** Packed tile key -> remaining extraction units (0 = exhausted). Absent = infinite / legacy. */
  readonly remaining: Map<number, number>
  /** Packed tile key -> the deposit's terrain render entity id (for the exhaustion grey-out). */
  readonly eid: Map<number, number>
}

export function createDepositStore(): DepositStore {
  return { remaining: new Map(), eid: new Map() }
}

/**
 * Remaining extraction units under tile (x, y), or {@link RICHNESS_INFINITE} for an infinite /
 * untracked tile. Read-only probe for the inspector/HUD (the depletion hot path keys off the
 * crafter's cached anchor directly). A Map lookup — allocation-free.
 */
export function depositRichnessAt(deposits: DepositStore, x: number, y: number): number {
  return deposits.remaining.get(tileKey(x, y)) ?? RICHNESS_INFINITE
}

/**
 * Map a technology's string id to a stable, non-zero 32-bit integer (FNV-1a) — the twin of
 * {@link terrainTypeOf} for techs. The sandboxed sim never enumerates or names technologies
 * (its {@link ModApi} only looks a prototype up by id); the host owns the string↔int mapping
 * and hashes ids through here so the integer the sim tracks as the "active"/"completed" tech
 * matches on both sides without the sim ever seeing the string. Deterministic and
 * allocation-free; `|| 1` keeps {@link RESEARCH_NONE} (0) reserved.
 */
export function techTypeOf(id: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0 || 1
}

/**
 * Map a recipe id string to a stable opaque integer the sim can store on a crafter (see
 * {@link BuildingStore.recipe}). Same FNV-1a hash as {@link techTypeOf}; the host owns the
 * string↔int map, the sim only ever tracks the integer. `|| 1` keeps 0 reserved for "no recipe".
 */
export function recipeTypeOf(id: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  // Mask to 31 bits so it is always a positive Int32 — the recipe id lives in an Int32Array on the
  // building store, and a value above 2^31 would wrap to a negative on write and mismatch the host.
  return h & 0x7fffffff || 1
}

/**
 * The whole base-game belt network as flat parallel arrays indexed by a dense belt-tile
 * id. `index` maps a packed tile coordinate to that id. Capacity grows (doubling) only
 * when tiles are placed; the per-tick hot path reads these arrays by index and never
 * allocates.
 */
export interface BeltGrid {
  /** Packed tile key -> belt-tile id. Map insertion order is deterministic. */
  readonly index: Map<number, number>
  /** Number of live belt tiles (<= capacity). */
  count: number
  /** Tile coordinates. */
  tx: Int32Array
  ty: Int32Array
  /** Facing direction index 0..3 for plain/output tiles. */
  face: Int8Array
  /** Per-tile feature: KIND_PLAIN | KIND_OUTPUT | KIND_INPUT | KIND_SPLITTER. */
  kind: Int8Array
  /** Item entity id riding the tile, or NONE. */
  slot: Int32Array
  /** Direction the current occupant entered with, or NONE for output-spawned items. */
  inDir: Int8Array
  /** Output tiles: ticks since the port last drained its building. */
  portTimer: Int32Array
  /** Output tiles: drain a resource from the linked building every N ticks. */
  portEvery: Int32Array
  /** Output/input tiles: dense building id this port is linked to, or NONE. */
  portBuilding: Int32Array
  /** Port tiles: colour-filter mode (FILTER_NONE | FILTER_WHITELIST | FILTER_BLACKLIST). */
  filterMode: Int8Array
  /** Port tiles: the filter's colours, `filterColor[t * MAX_PORT_FILTER + j]`; unused slots hold {@link FILTER_EMPTY}. */
  filterColor: Int32Array
  /** Splitter tiles: round-robin cursor (next direction to try). */
  rr: Int8Array
  /** Track entity id drawn under each tile (re-oriented when a tile's facing changes). */
  trackEid: Int32Array
  /**
   * Overlay entity id drawn on top of a port/splitter tile (the arrow/splitter glyph), or
   * NONE for a plain belt tile. Tracked so deletion can despawn the overlay along with the
   * track entity; a plain belt has only its {@link trackEid}.
   */
  markEid: Int32Array
  /** Neighbour belt-tile id per direction: nbr[t*4 + d], or NONE. Rebuilt on placement. */
  nbr: Int32Array
  /**
   * Underground-cap pairing: the belt-tile id of the tile's tunnel partner, or NONE for an ordinary
   * tile. An entrance ({@link KIND_UNDER_IN}) stores its exit, an exit ({@link KIND_UNDER_OUT}) its
   * entrance (both directions, so removing either cap finds the other). {@link rebuildTopology} wires
   * an entrance's forward neighbour to this partner, which is what carries the item under the gap.
   */
  partner: Int32Array
  /** Processing order (downstream tiles first). Rebuilt on placement. */
  order: Int32Array
  /** Per-tile move period in ticks — the belt tier's `moveEvery`. Set at placement. */
  period: Int32Array
  /** Per-tile cadence: advance this tile's item every `dueEvery` base-cycles (period / base). */
  dueEvery: Int32Array
  /**
   * Base move-cycle in ticks: the GCD of every tile's `period`. The grid steps once per
   * base-cycle and each tile moves its item every `dueEvery` of those cycles, so belt tiers
   * with different periods coexist (a faster tier just has a smaller `dueEvery`). A
   * single-tier grid has base === that tier's period and `dueEvery` === 1 everywhere,
   * reproducing the old uniform-speed behaviour exactly.
   */
  moveEvery: number
  /** Ticks elapsed in the current base-cycle. */
  moveTimer: number
  /** Base-cycles elapsed; a tile is due to move when `moveCount % dueEvery === 0`. */
  moveCount: number
  /**
   * Transient batch flag: set when a placement command changes topology, so the O(n)
   * {@link rebuildTopology} runs once at the end of the command batch instead of once per
   * command (turning a bulk build — blueprint paste, map load — from O(n²) into O(n)).
   * Never serialized: always cleared before the belt system reads `nbr`/`order`.
   */
  topoDirty: number
}

/**
 * Pack a tile coordinate into a single integer key. Range covers a huge map. Exported so
 * the read-only UI inspector can probe the belt grid's `index` at a hovered tile.
 */
const KEY_BIAS = 1 << 20
const KEY_STRIDE = 1 << 21
export function tileKey(x: number, y: number): number {
  return (x + KEY_BIAS) * KEY_STRIDE + (y + KEY_BIAS)
}

export function createBeltGrid(moveEvery: number): BeltGrid {
  const cap = 16
  return {
    index: new Map(),
    count: 0,
    tx: new Int32Array(cap),
    ty: new Int32Array(cap),
    face: new Int8Array(cap),
    kind: new Int8Array(cap),
    slot: new Int32Array(cap).fill(NONE),
    inDir: new Int8Array(cap).fill(NONE),
    portTimer: new Int32Array(cap),
    portEvery: new Int32Array(cap),
    portBuilding: new Int32Array(cap).fill(NONE),
    filterMode: new Int8Array(cap),
    filterColor: new Int32Array(cap * MAX_PORT_FILTER).fill(FILTER_EMPTY),
    rr: new Int8Array(cap),
    trackEid: new Int32Array(cap).fill(NONE),
    markEid: new Int32Array(cap).fill(NONE),
    nbr: new Int32Array(cap * 4).fill(NONE),
    partner: new Int32Array(cap).fill(NONE),
    order: new Int32Array(cap),
    period: new Int32Array(cap).fill(Math.max(1, moveEvery)),
    dueEvery: new Int32Array(cap).fill(1),
    moveEvery: Math.max(1, moveEvery),
    moveTimer: 0,
    moveCount: 0,
    topoDirty: 0,
  }
}

/** Integer sign: -1, 0 or 1. */
function sign(n: number): number {
  return n > 0 ? 1 : n < 0 ? -1 : 0
}

/** Direction index for a unit step (dx, dy); defaults to East for a zero step. */
function dirOf(dx: number, dy: number): number {
  if (dy < 0) return 0
  if (dx > 0) return 1
  if (dy > 0) return 2
  if (dx < 0) return 3
  return 1
}

/**
 * Project the drawn segment A->B onto its dominant axis, yielding a straight,
 * axis-aligned run. Shared by placement (for the ghost preview) and the belt rasterizer
 * so the preview and the real belt always agree.
 */
export function projectBelt(
  ax: number,
  ay: number,
  bx: number,
  by: number,
): { dx: number; dy: number; length: number } {
  const ddx = bx - ax
  const ddy = by - ay
  if (Math.abs(ddx) >= Math.abs(ddy)) {
    return { dx: sign(ddx), dy: 0, length: Math.abs(ddx) + 1 }
  }
  return { dx: 0, dy: sign(ddy), length: Math.abs(ddy) + 1 }
}

/**
 * One axis-aligned leg of a belt path: its endpoints, unit step and tile count (endpoints
 * inclusive). Exactly one of `dx`/`dy` is non-zero (the other 0) for a real run; a zero-length
 * leg (a single tile) has both 0.
 */
export interface BeltLeg {
  readonly ax: number
  readonly ay: number
  readonly bx: number
  readonly by: number
  readonly dx: number
  readonly dy: number
  readonly length: number
}

/**
 * An L-shaped belt path from A to B: a `corner` tile and one or two axis-aligned {@link BeltLeg}s.
 * `legs[0]` runs A -> corner along the first axis; `legs[1]` (present only for a real bend) runs
 * corner -> B along the perpendicular axis, sharing the corner tile. `length` counts distinct
 * tiles along the whole path (the corner once).
 */
export interface BeltPath {
  readonly corner: { readonly x: number; readonly y: number }
  readonly legs: readonly BeltLeg[]
  readonly length: number
}

/** Build an axis-aligned {@link BeltLeg} from (ax,ay) to (bx,by). One axis must be constant. */
function beltLeg(ax: number, ay: number, bx: number, by: number): BeltLeg {
  return {
    ax,
    ay,
    bx,
    by,
    dx: sign(bx - ax),
    dy: sign(by - ay),
    length: Math.abs(bx - ax) + Math.abs(by - ay) + 1,
  }
}

/**
 * Route the drawn segment A->B as an L: a run along one axis to a corner, then the perpendicular
 * run to B. By default the first (longer) leg follows the dominant axis — `projectBelt`'s choice —
 * so the corner sits at `(bx, ay)` for a mostly-horizontal drag or `(ax, by)` for a mostly-vertical
 * one; `flip` swaps which axis goes first (a Shift-held drag). When A and B already share a row or
 * column the perpendicular leg is empty and the path degenerates to the single straight run
 * `projectBelt` would produce, so a straight drag is byte-for-byte unchanged. Pure and deterministic;
 * used only at placement time (ghost preview + enqueuing the two `place_belt` legs), never on the
 * per-tick hot path, so the small allocation here is fine.
 */
export function projectBeltPath(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  flip = false,
): BeltPath {
  const ddx = bx - ax
  const ddy = by - ay
  const dominantHorizontal = Math.abs(ddx) >= Math.abs(ddy)
  const firstHorizontal = flip ? !dominantHorizontal : dominantHorizontal
  const cx = firstHorizontal ? bx : ax
  const cy = firstHorizontal ? ay : by
  // A zero-delta axis collapses the L to the single straight run projectBelt would draw: when the
  // corner coincides with A the first leg is empty, when it coincides with B the second is — either
  // way there is just one A→B leg. So an aligned drag (even Shift-flipped) is byte-for-byte the old
  // behaviour: one command, one ghost band.
  if ((cx === ax && cy === ay) || (cx === bx && cy === by)) {
    const only = beltLeg(ax, ay, bx, by)
    return { corner: { x: bx, y: by }, legs: [only], length: only.length }
  }
  const corner = { x: cx, y: cy }
  const first = beltLeg(ax, ay, cx, cy)
  const second = beltLeg(cx, cy, bx, by)
  return { corner, legs: [first, second], length: first.length + second.length - 1 }
}

/** Grow every per-tile buffer to at least `need` capacity (doubling), off the hot path. */
function ensureCapacity(g: BeltGrid, need: number): void {
  const cap = g.tx.length
  if (need <= cap) return
  let next = cap
  while (next < need) next *= 2
  g.tx = grow(g.tx, next, 0)
  g.ty = grow(g.ty, next, 0)
  g.face = grow8(g.face, next, 0)
  g.kind = grow8(g.kind, next, 0)
  g.slot = grow(g.slot, next, NONE)
  g.inDir = grow8(g.inDir, next, NONE)
  g.portTimer = grow(g.portTimer, next, 0)
  g.portEvery = grow(g.portEvery, next, 0)
  g.portBuilding = grow(g.portBuilding, next, NONE)
  g.filterMode = grow8(g.filterMode, next, 0)
  g.filterColor = grow(g.filterColor, next * MAX_PORT_FILTER, FILTER_EMPTY)
  g.rr = grow8(g.rr, next, 0)
  g.trackEid = grow(g.trackEid, next, NONE)
  g.markEid = grow(g.markEid, next, NONE)
  g.nbr = grow(g.nbr, next * 4, NONE)
  g.partner = grow(g.partner, next, NONE)
  g.order = grow(g.order, next, 0)
  g.period = grow(g.period, next, 1)
  g.dueEvery = grow(g.dueEvery, next, 1)
}

function grow(src: Int32Array, len: number, fill: number): Int32Array {
  const out = new Int32Array(len)
  if (fill !== 0) out.fill(fill)
  out.set(src)
  return out
}

function grow8(src: Int8Array, len: number, fill: number): Int8Array {
  const out = new Int8Array(len)
  if (fill !== 0) out.fill(fill)
  out.set(src)
  return out
}

/**
 * Grow a Float64 buffer (the twin of {@link grow} for {@link tileKey} values). A packed tile key can
 * exceed 2^31, so a cached anchor key lives in a Float64Array — an Int32Array would silently truncate
 * it. Integers up to 2^53 are exact in a float, and a tile key is well under that.
 */
function growF64(src: Float64Array, len: number, fill: number): Float64Array {
  const out = new Float64Array(len)
  if (fill !== 0) out.fill(fill)
  out.set(src)
  return out
}

/**
 * Look up the belt-tile id at (x, y), or NONE. Used at placement time and to wire
 * neighbours — never on the per-tick hot path.
 */
function tileAt(g: BeltGrid, x: number, y: number): number {
  const t = g.index.get(tileKey(x, y))
  return t === undefined ? NONE : t
}

/**
 * Add a fresh belt tile at (x, y) facing `face`, spawning its track entity, or — if a
 * tile already exists there — just re-aim it (this is how redrawing a run over an
 * existing belt rewrites its direction). Returns the tile id. Topology links are rebuilt
 * by the caller once the whole run is placed.
 */
function addOrAimTile(
  gw: GameWorld,
  api: ModApi,
  g: BeltGrid,
  x: number,
  y: number,
  face: number,
  color: number,
  period: number,
): number {
  const existing = tileAt(g, x, y)
  if (existing !== NONE) {
    g.face[existing] = face
    // Redrawing a run over an existing tile also re-tiers it (e.g. upgrade a belt to a faster mk).
    g.period[existing] = period
    if (g.kind[existing] === KIND_PLAIN) {
      gw.components.Renderable.sprite[g.trackEid[existing]!] = sprite(SHAPE_BELT_ARROW, face)
    }
    return existing
  }
  ensureCapacity(g, g.count + 1)
  const t = g.count++
  g.tx[t] = x
  g.ty[t] = y
  g.face[t] = face
  g.kind[t] = KIND_PLAIN
  g.slot[t] = NONE
  g.inDir[t] = NONE
  g.rr[t] = 0
  g.period[t] = period
  g.markEid[t] = NONE
  // Clear any port filter left in this (possibly swap-reused) slot, so a future port here starts clean.
  clearPortFilter(g, t)
  g.trackEid[t] = api.spawn({
    pos: { x, y },
    sprite: sprite(SHAPE_BELT_ARROW, face),
    color,
    width: 1,
    height: 1,
  })
  g.index.set(tileKey(x, y), t)
  return t
}

/**
 * Recompute neighbour links and the downstream-first processing order. Runs after any
 * topology change (off the hot path). The order is a reverse-topological sort (sinks
 * first) of the successor graph so a full train advances one tile per move-cycle; tiles
 * left in cycles are appended in tile-id order, keeping the result deterministic.
 */
function rebuildTopology(g: BeltGrid): void {
  const n = g.count
  const { nbr, order, kind, face, partner } = g
  for (let t = 0; t < n; t++) {
    for (let d = 0; d < 4; d++) {
      nbr[t * 4 + d] = tileAt(g, g.tx[t]! + DX[d]!, g.ty[t]! + DY[d]!)
    }
  }

  // Underground tunnels: rewrite each entrance's *forward* neighbour to its paired exit tile (an
  // arbitrary edge the neighbour table already expresses), so the item hops entrance→exit in one
  // move-cycle and skips the buildable gap tiles entirely. The exit keeps its physical neighbours,
  // feeding whatever it faces like any belt. A cap with no valid partner (a transient during removal)
  // dead-ends, which is safe — it simply carries nothing rather than teleporting into a wrong tile.
  for (let t = 0; t < n; t++) {
    if (kind[t] !== KIND_UNDER_IN) continue
    const p = partner[t]!
    nbr[t * 4 + face[t]!] = p !== NONE && p < n ? p : NONE
  }

  // out-degree over successor edges (PLAIN/OUTPUT -> faced neighbour; SPLITTER -> all
  // neighbours; INPUT -> none). Kahn's algorithm peels sinks first. To keep the whole rebuild
  // O(n) rather than O(n²) — it runs once per placement, so an O(n²) scan turns map construction
  // super-linear — we first bucket every successor edge into a flat predecessor adjacency (CSR).
  // Peeling a sink then visits only its real predecessors instead of rescanning all n tiles.
  const outDeg = new Int32Array(n)
  const predCount = new Int32Array(n) // in-degree per tile, used to size the CSR below
  for (let s = 0; s < n; s++) {
    outDeg[s] = successorCount(g, s)
    if (kind[s] === KIND_INPUT) continue
    if (kind[s] === KIND_SPLITTER) {
      for (let d = 0; d < 4; d++) {
        const t = nbr[s * 4 + d]!
        if (t !== NONE && !hasForwardEdge(g, t, s)) predCount[t]!++
      }
    } else {
      const t = nbr[s * 4 + face[s]!]!
      if (t !== NONE) predCount[t]!++
    }
  }
  // CSR offsets: predOff[t]..predOff[t+1] is tile t's slice of predList.
  const predOff = new Int32Array(n + 1)
  for (let t = 0; t < n; t++) predOff[t + 1] = predOff[t]! + predCount[t]!
  const predList = new Int32Array(predOff[n]!)
  const cursor = predOff.slice(0, n) // per-tile write head; ascending s preserves prior tie-order
  for (let s = 0; s < n; s++) {
    if (kind[s] === KIND_INPUT) continue
    if (kind[s] === KIND_SPLITTER) {
      for (let d = 0; d < 4; d++) {
        const t = nbr[s * 4 + d]!
        if (t !== NONE && !hasForwardEdge(g, t, s)) predList[cursor[t]!++] = s
      }
    } else {
      const t = nbr[s * 4 + face[s]!]!
      if (t !== NONE) predList[cursor[t]!++] = s
    }
  }

  let head = 0
  let tail = 0
  for (let t = 0; t < n; t++) {
    if (outDeg[t] === 0) order[tail++] = t
  }
  while (head < tail) {
    const t = order[head++]!
    // Decrement out-degree of every predecessor that feeds t (ascending s, matching the old scan).
    for (let k = predOff[t]!; k < predOff[t + 1]!; k++) {
      const s = predList[k]!
      if (outDeg[s]! > 0) {
        outDeg[s]!--
        if (outDeg[s] === 0) order[tail++] = s
      }
    }
  }
  // Tiles still in cycles never hit out-degree 0; append them in id order.
  for (let t = 0; t < n; t++) {
    if (outDeg[t]! > 0) order[tail++] = t
  }
}

/** Greatest common divisor (Euclid; positive integer inputs). */
function gcd(a: number, b: number): number {
  while (b !== 0) {
    const r = a % b
    a = b
    b = r
  }
  return a
}

/**
 * Recompute the grid's base move-cycle and every tile's cadence after a placement. The base is
 * the GCD of all tile periods, so each `dueEvery = period / base` is a whole number: the fastest
 * tier moves every base-cycle, slower tiers every Nth. A single-tier grid yields base === that
 * tier's period and dueEvery === 1 for every tile (identical to the old uniform-speed model). When
 * the base changes the cycle length changes, so the timer/counter reset keeps the phase clean.
 * Off the hot path (placement only).
 */
function recomputeCadence(g: BeltGrid): void {
  const n = g.count
  if (n === 0) return
  let base = g.period[0]!
  for (let t = 1; t < n; t++) base = gcd(base, g.period[t]!)
  if (base < 1) base = 1
  for (let t = 0; t < n; t++) g.dueEvery[t] = (g.period[t]! / base) | 0 || 1
  if (base !== g.moveEvery) {
    g.moveEvery = base
    g.moveTimer = 0
    g.moveCount = 0
  }
}

/**
 * Whether tile s has a *forward* edge to t, before the splitter-source exclusion: a
 * plain/output tile feeds the tile it faces; a splitter feeds every adjacent belt tile;
 * an input feeds nothing.
 */
function hasForwardEdge(g: BeltGrid, s: number, t: number): boolean {
  if (g.kind[s] === KIND_INPUT) return false
  if (g.kind[s] === KIND_SPLITTER) {
    for (let d = 0; d < 4; d++) if (g.nbr[s * 4 + d] === t) return true
    return false
  }
  return g.nbr[s * 4 + g.face[s]!] === t
}

/**
 * The successor (downstream) edge relation, `feeds(s, t)`, is enumerated inline in
 * {@link rebuildTopology}: a plain/output tile feeds the tile it faces; a splitter feeds every
 * adjacent belt tile *except* one that itself feeds the splitter (that neighbour is the source,
 * not a sink — counting it would forge a 2-cycle that defeats the topological sort); an input
 * feeds nothing. {@link successorCount} counts those same edges.
 */

/** Number of successor (downstream) edges out of tile t. */
function successorCount(g: BeltGrid, t: number): number {
  if (g.kind[t] === KIND_INPUT) return 0
  if (g.kind[t] === KIND_SPLITTER) {
    let c = 0
    for (let d = 0; d < 4; d++) {
      const nb = g.nbr[t * 4 + d]!
      if (nb !== NONE && !hasForwardEdge(g, nb, t)) c++
    }
    return c
  }
  return g.nbr[t * 4 + g.face[t]!] !== NONE ? 1 : 0
}

// --- Building store ---------------------------------------------------------

/**
 * Maximum distinct resources a single building can stockpile. Fixed so the store stays a
 * flat Structure-of-Arrays buffer (no per-building objects); plenty for the handful of base
 * resources. Slots beyond this on an over-long accept list are dropped at registration.
 */
export const MAX_SLOTS = 8

/**
 * Per-slot role bits (bitmask in {@link BuildingStore.slotRole}). A slot can be a deposit
 * target (an input port fills it, matched by colour), a drain source (an output port pulls
 * from it), or both. A crafter's recipe *inputs* are deposit-only (so an output port can
 * never pull raw materials back out), its *outputs* drain-only; a plain resource store
 * (village, generic building) is both — belts can fill it and, in principle, drain it.
 */
export const ROLE_DEPOSIT = 1
export const ROLE_DRAIN = 2

/**
 * Every resource-holding building as flat parallel arrays indexed by a dense building id. A
 * *crafter* runs a recipe: it consumes its deposit (input) slots and fills its drain (output)
 * slots every `craftEvery` ticks. Output/input ports (see {@link BeltGrid.portBuilding})
 * drain/fill these slots. Buildings without a stockpile (the apple orchard, plain scenery) are
 * never registered here. Lives outside the ECS world, like {@link BeltGrid}; grown only at
 * registration, read by index on the hot path.
 */
export interface BuildingStore {
  /** Packed key of *every* footprint tile -> dense building id (port/inspector lookup). */
  readonly tileIndex: Map<number, number>
  /** Number of live buildings (<= capacity). */
  count: number
  /** The building's footprint entity id (inspector/render cross-reference). */
  eid: Int32Array
  /** Footprint top-left and size. */
  bx: Int32Array
  by: Int32Array
  bw: Int32Array
  bh: Int32Array
  /** 1 if this building runs a recipe (a crafter), 0 for a pure store. */
  crafts: Int8Array
  /**
   * 1 if this building is a *depot* (a sales sink): items arriving on its input ports are SOLD —
   * their {@link PriceTable} price credited straight into the global {@link TreasuryStore} —
   * instead of being stocked in a slot, so a depot needs no accept slots and is not bound by
   * {@link MAX_SLOTS}. 0 otherwise.
   */
  depot: Int8Array
  /**
   * 1 if this building is a *silo* — the dedicated receiver a cargo cannon fires into. A cannon may
   * only target a silo (never a generic store/depot), and only when the silo is empty. Structurally
   * it is still a store (a deposit+drain slot the shell fills and output ports drain). 0 otherwise.
   */
  silo: Int8Array
  /**
   * The recipe a crafter is currently set to, as an opaque integer id (see {@link recipeTypeOf}),
   * or 0 for an empty crafter with no recipe yet. Drives no sim logic (the slots do) — it is kept
   * so the UI can show/highlight the chosen recipe and so it survives save/load.
   */
  recipe: Int32Array
  /** Crafter cadence: attempt one craft every N ticks (recipe `time` / building `speed`). */
  craftEvery: Int32Array
  /** Ticks since this crafter last attempted/completed a craft. */
  craftTimer: Int32Array
  /** Number of active stockpile slots (<= MAX_SLOTS). */
  slotN: Int32Array
  /** Flattened per-slot resource colour: [id*MAX_SLOTS + k]. */
  slotColor: Int32Array
  /** Flattened per-slot current count. */
  slotCount: Int32Array
  /** Flattened per-slot capacity. */
  slotCap: Int32Array
  /** Flattened per-slot role bits (ROLE_DEPOSIT | ROLE_DRAIN). */
  slotRole: Int8Array
  /** Flattened per-slot recipe amount: units consumed (input) or produced (output) per craft; 0 if not a recipe slot. */
  slotAmt: Int32Array
  /**
   * Cached packed tile key of the deposit an *extraction* crafter depletes (its anchor tile), or
   * {@link NONE} for any building that is not a finite-deposit extractor. Set once at placement so
   * the depletion hot path ({@link runCrafters}) can look up the tile's richness by a bare integer
   * key — never recomputing it — and skip the lookup entirely for ordinary machines. Float64 because a
   * packed {@link tileKey} can exceed the Int32 range (it would truncate to a bogus key otherwise).
   */
  anchorKey: Float64Array
  /**
   * Per-building upkeep in credits, drained from the treasury once per {@link UPKEEP_CADENCE} (G6).
   * Authored per building *type* (`buildings.json`'s optional `upkeep`, default 0 — belts/ports/
   * depots stay free), passed in at placement. 0 for anything with no upkeep, so the drain skips it.
   */
  upkeep: Int32Array
}

export function createBuildingStore(): BuildingStore {
  const cap = 8
  return {
    tileIndex: new Map(),
    count: 0,
    eid: new Int32Array(cap).fill(NONE),
    bx: new Int32Array(cap),
    by: new Int32Array(cap),
    bw: new Int32Array(cap),
    bh: new Int32Array(cap),
    crafts: new Int8Array(cap),
    depot: new Int8Array(cap),
    silo: new Int8Array(cap),
    recipe: new Int32Array(cap),
    craftEvery: new Int32Array(cap).fill(1),
    craftTimer: new Int32Array(cap),
    slotN: new Int32Array(cap),
    slotColor: new Int32Array(cap * MAX_SLOTS),
    slotCount: new Int32Array(cap * MAX_SLOTS),
    slotCap: new Int32Array(cap * MAX_SLOTS),
    slotRole: new Int8Array(cap * MAX_SLOTS),
    slotAmt: new Int32Array(cap * MAX_SLOTS),
    anchorKey: new Float64Array(cap).fill(NONE),
    upkeep: new Int32Array(cap),
  }
}

/** Grow every building buffer to at least `need` capacity (doubling), off the hot path. */
function ensureBuildingCapacity(s: BuildingStore, need: number): void {
  const cap = s.eid.length
  if (need <= cap) return
  let next = cap
  while (next < need) next *= 2
  s.eid = grow(s.eid, next, NONE)
  s.bx = grow(s.bx, next, 0)
  s.by = grow(s.by, next, 0)
  s.bw = grow(s.bw, next, 0)
  s.bh = grow(s.bh, next, 0)
  s.crafts = grow8(s.crafts, next, 0)
  s.depot = grow8(s.depot, next, 0)
  s.silo = grow8(s.silo, next, 0)
  s.recipe = grow(s.recipe, next, 0)
  s.craftEvery = grow(s.craftEvery, next, 1)
  s.craftTimer = grow(s.craftTimer, next, 0)
  s.slotN = grow(s.slotN, next, 0)
  s.slotColor = grow(s.slotColor, next * MAX_SLOTS, 0)
  s.slotCount = grow(s.slotCount, next * MAX_SLOTS, 0)
  s.slotCap = grow(s.slotCap, next * MAX_SLOTS, 0)
  s.slotRole = grow8(s.slotRole, next * MAX_SLOTS, 0)
  s.slotAmt = grow(s.slotAmt, next * MAX_SLOTS, 0)
  s.anchorKey = growF64(s.anchorKey, next, NONE)
  s.upkeep = grow(s.upkeep, next, 0)
}

/**
 * A stockpile slot definition: which resource (colour), how much it can hold, its role bits
 * ({@link ROLE_DEPOSIT} | {@link ROLE_DRAIN}), and its recipe amount (units consumed/produced
 * per craft; 0 for a plain store slot). {@link AcceptSlot} is the simpler `{ color, cap }`
 * form for a pure store; {@link registerBuilding} widens it to a deposit+drain store slot.
 */
export interface BuildingSlot {
  readonly color: number
  readonly cap: number
  readonly role: number
  readonly amt: number
}

/** A pure-store stockpile slot: which resource (colour) and how much it can hold. */
export interface AcceptSlot {
  readonly color: number
  readonly cap: number
}

/** Widen a pure-store `{ color, cap }` accept list into deposit+drain store slots (amt 0). */
function storeSlots(accepts: readonly AcceptSlot[]): BuildingSlot[] {
  const slots: BuildingSlot[] = []
  for (let j = 0; j < accepts.length; j++) {
    slots.push({
      color: accepts[j]!.color,
      cap: accepts[j]!.cap,
      role: ROLE_DEPOSIT | ROLE_DRAIN,
      amt: 0,
    })
  }
  return slots
}

/**
 * Register a resource-holding building: record its footprint (every tile maps back to it),
 * whether it runs a recipe (`crafts`) and how often (`craftEvery`), and its stockpile slots
 * (each with a colour, cap, role bits and recipe amount). Returns the dense building id. Off
 * the hot path (placement/scene only).
 */
export function registerBuilding(
  store: BuildingStore,
  eid: number,
  x: number,
  y: number,
  w: number,
  h: number,
  crafts: number,
  craftEvery: number,
  slots: readonly BuildingSlot[],
  depot = 0,
  silo = 0,
  upkeep = 0,
): number {
  ensureBuildingCapacity(store, store.count + 1)
  const b = store.count++
  store.eid[b] = eid
  store.bx[b] = x
  store.by[b] = y
  store.bw[b] = w
  store.bh[b] = h
  store.crafts[b] = crafts ? 1 : 0
  store.depot[b] = depot ? 1 : 0
  store.silo[b] = silo ? 1 : 0
  store.recipe[b] = 0
  store.craftEvery[b] = Math.max(1, craftEvery)
  store.craftTimer[b] = 0
  store.anchorKey[b] = NONE // set by place_crafter only for a finite-deposit extractor
  store.upkeep[b] = Math.max(0, upkeep)
  let n = 0
  for (let j = 0; j < slots.length && n < MAX_SLOTS; j++) {
    const i = b * MAX_SLOTS + n
    store.slotColor[i] = slots[j]!.color
    store.slotCount[i] = 0
    store.slotCap[i] = Math.max(0, slots[j]!.cap)
    store.slotRole[i] = slots[j]!.role
    store.slotAmt[i] = Math.max(0, slots[j]!.amt)
    n++
  }
  store.slotN[b] = n
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      store.tileIndex.set(tileKey(x + dx, y + dy), b)
    }
  }
  return b
}

/** The building id whose footprint covers (x, y), or NONE. */
export function buildingAt(store: BuildingStore, x: number, y: number): number {
  const b = store.tileIndex.get(tileKey(x, y))
  return b === undefined ? NONE : b
}

/**
 * Re-arm an existing crafter `b` with a recipe: replace its stockpile slots (inputs deposit-only,
 * outputs drain-only — same layout {@link registerBuilding} builds for a crafter), set its cadence
 * and recipe id, mark it a crafter, and reset the craft timer. Any held stock is dropped because the
 * slot resource types change with the recipe. `recipe === 0` clears it back to an empty machine.
 * Off the hot path (player recipe change only).
 */
export function setBuildingRecipe(
  store: BuildingStore,
  b: number,
  recipe: number,
  inputs: readonly CraftFlow[],
  outputs: readonly CraftFlow[],
  craftEvery: number,
  storageCap: number,
): void {
  const base = b * MAX_SLOTS
  let n = 0
  const push = (color: number, amt: number, role: number): void => {
    if (n >= MAX_SLOTS) return
    const i = base + n
    store.slotColor[i] = color
    store.slotCount[i] = 0
    store.slotCap[i] = Math.max(0, storageCap)
    store.slotRole[i] = role
    store.slotAmt[i] = Math.max(0, amt)
    n++
  }
  for (let i = 0; i < inputs.length; i++) push(inputs[i]!.color, inputs[i]!.amount, ROLE_DEPOSIT)
  for (let i = 0; i < outputs.length; i++) push(outputs[i]!.color, outputs[i]!.amount, ROLE_DRAIN)
  // Zero any leftover slots beyond the new recipe's set so stale stock can't linger.
  for (let k = n; k < store.slotN[b]!; k++) {
    const i = base + k
    store.slotColor[i] = 0
    store.slotCount[i] = 0
    store.slotCap[i] = 0
    store.slotRole[i] = 0
    store.slotAmt[i] = 0
  }
  store.slotN[b] = n
  store.crafts[b] = 1
  store.recipe[b] = recipe
  store.craftEvery[b] = Math.max(1, craftEvery)
  store.craftTimer[b] = 0
}

/**
 * Deposit slot index (0..slotN) holding `color` in building `b`, or NONE. Only slots an input
 * port may fill (role {@link ROLE_DEPOSIT}) are considered, so an item can never be pushed into
 * a crafter's drain-only output slot. Bounded scan.
 */
function findSlot(store: BuildingStore, b: number, color: number): number {
  const n = store.slotN[b]!
  for (let k = 0; k < n; k++) {
    const i = b * MAX_SLOTS + k
    if (store.slotColor[i] === color && store.slotRole[i]! & ROLE_DEPOSIT) return k
  }
  return NONE
}

/** Reset belt tile `t`'s port filter to "none" (empty colour slots). Off the hot path. */
function clearPortFilter(g: BeltGrid, t: number): void {
  g.filterMode[t] = FILTER_NONE
  const base = t * MAX_PORT_FILTER
  for (let j = 0; j < MAX_PORT_FILTER; j++) g.filterColor[base + j] = FILTER_EMPTY
}

/** Whether `color` passes port tile `t`'s colour filter (always true for an unfiltered port). */
function portFilterPasses(g: BeltGrid, t: number, color: number): boolean {
  const mode = g.filterMode[t]!
  if (mode === FILTER_NONE) return true
  const base = t * MAX_PORT_FILTER
  let listed = false
  for (let j = 0; j < MAX_PORT_FILTER; j++) {
    if (g.filterColor[base + j] === color) {
      listed = true
      break
    }
  }
  return mode === FILTER_WHITELIST ? listed : !listed
}

/**
 * First drainable slot of building `b` whose colour passes output-port tile `t`'s filter and holds
 * at least one unit, or NONE. Only slots an output port may pull (role {@link ROLE_DRAIN}), so an
 * output on a crafter drains its product, never its raw inputs; the filter further lets it pull one
 * specific product off a multi-output machine. Fixed slot order, bounded scan.
 */
function firstDrainableForPort(store: BuildingStore, b: number, g: BeltGrid, t: number): number {
  const n = store.slotN[b]!
  for (let k = 0; k < n; k++) {
    const i = b * MAX_SLOTS + k
    if (
      store.slotRole[i]! & ROLE_DRAIN &&
      store.slotCount[i]! > 0 &&
      portFilterPasses(g, t, store.slotColor[i]!)
    ) {
      return k
    }
  }
  return NONE
}

/**
 * The direction from a port tile to the building it bridges, read off the port's facing arrow:
 * an OUTPUT's arrow points *away* from the building it drains (the arrow starts on the building),
 * so its building lies opposite the facing; an INPUT's arrow points *into* the building it feeds,
 * so its building lies in the facing direction. This is what lets a port tile that borders two
 * buildings bind to exactly one — the arrow picks the side.
 */
function portLinkDir(g: BeltGrid, t: number): number {
  return g.kind[t] === KIND_OUTPUT ? opposite(g.face[t]!) : g.face[t]!
}

/**
 * Link the belt port at tile `t` to the single building its arrow designates (see
 * {@link portLinkDir}) — the one orthogonally adjacent on that side — or NONE if no building
 * borders it there. Off the hot path (port placement, or a re-link when a building is placed
 * beside an existing port).
 */
function linkPort(g: BeltGrid, store: BuildingStore, t: number): void {
  const d = portLinkDir(g, t)
  g.portBuilding[t] = buildingAt(store, g.tx[t]! + DX[d]!, g.ty[t]! + DY[d]!)
}

/**
 * Re-link every output/input port that has no building yet. Called after a building is
 * placed so a port laid down *before* its building still finds it. Off the hot path; bounded
 * by the (small) number of ports, and `linkPort` only ever links to an adjacent building.
 */
function relinkUnlinkedPorts(g: BeltGrid, store: BuildingStore): void {
  for (let t = 0; t < g.count; t++) {
    if ((g.kind[t] === KIND_OUTPUT || g.kind[t] === KIND_INPUT) && g.portBuilding[t] === NONE) {
      linkPort(g, store, t)
    }
  }
}

// --- Villages ---------------------------------------------------------------

/**
 * How often the village system runs (ticks). Consumption + growth/decline are evaluated once
 * per cadence, not every tick — villages change slowly and this keeps the per-tick cost near
 * zero. At 60 tps this is one evaluation per second.
 */
export const VILLAGE_CADENCE = 60
/** Ticks per in-game minute at 60 tps — used to convert a demand's `ratePerMin` to per-cadence units. */
export const VILLAGE_TICKS_PER_MIN = 3600
/** Sustained cadences of full satisfaction before a village grows a stage (10s at 60 tps). */
export const VILLAGE_GROWTH_AFTER = 600
/** Sustained cadences of unmet demand before a village drops a stage (10s at 60 tps). */
export const VILLAGE_DECLINE_AFTER = 600
/**
 * Startup grace, in ticks, granted to every newly-founded village: a fresh settlement's buffer is
 * empty, so without this it would "decline" (and raise the declining alert) from tick 0 — long before
 * a player could plausibly route supply to it. During the grace window decline neither accrues nor
 * alerts; the window ends on the first cadence the village is fully supplied, or when it elapses,
 * whichever comes first. Five in-game minutes at 60 tps. Not serialized as a knob — a per-village
 * countdown carries the remaining grace across saves.
 */
export const VILLAGE_DECLINE_GRACE = 5 * VILLAGE_TICKS_PER_MIN
/** Max demands a single stage may carry — sizes the per-village fractional-demand accumulators. */
export const MAX_VILLAGE_DEMANDS = 8

/**
 * One demand of a village stage: a resource colour and the authored consumption rate in units per
 * in-game minute. The rate is honoured exactly via a per-village fractional accumulator (see
 * {@link updateVillages}) rather than rounded to a per-cadence integer — a low rate like 6/min
 * genuinely consumes one unit every ten seconds instead of collapsing to the 1-per-cadence floor.
 */
export interface VillageDemand {
  readonly color: number
  readonly ratePerMin: number
}

/** A village stage: its (cumulative) demands and a flavour population figure. */
export interface VillageStageConfig {
  readonly population: number
  readonly demands: readonly VillageDemand[]
}

/**
 * The villages: flat parallel arrays indexed by a dense village id, each carrying its own stage
 * ladder in {@link VillageStore.ladders} (distinct settlements — a spaceport, a mining camp, a
 * research colony — advance up *different* demand ladders, so each village owns one). A village
 * consumes its current stage's demands from its own building stockpile (its buffer) every
 * {@link VILLAGE_CADENCE} ticks: satisfy every demand and a growth timer accrues toward the
 * next stage; miss any and a decline timer accrues toward the previous one (floored at stage 0
 * — a village is never removed). Anchored by tile so it survives building-store compaction.
 */
export interface VillageStore {
  /** Number of live villages. */
  count: number
  /** Village anchor tile (top-left of its footprint) — re-resolved to a building id each cadence. */
  vx: Int32Array
  vy: Int32Array
  /** Current stage index (0-based; 0 = level 1). */
  stage: Int32Array
  /** Cadences of sustained full satisfaction (toward growth). */
  growthTimer: Int32Array
  /** Cadences of sustained unmet demand (toward decline). */
  declineTimer: Int32Array
  /**
   * Remaining startup-grace ticks per village (see {@link VILLAGE_DECLINE_GRACE}). While positive,
   * decline is suppressed and the declining alert stays silent; it counts down each cadence and is
   * cleared the first time the village is fully supplied. Serialized so the window survives a save.
   */
  graceTimer: Int32Array
  /**
   * Per-village fractional-demand accumulators, flat `[village * MAX_VILLAGE_DEMANDS + demand]`, in
   * units of "unit·ticks": each cadence a demand accrues `ratePerMin * VILLAGE_CADENCE`, and every
   * whole {@link VILLAGE_TICKS_PER_MIN} accrued is one integer unit due. This is what lets a demand
   * consume a sub-per-cadence rate exactly. Reset when a village changes stage (the active demand
   * set changes, so stale carry-over would be meaningless). Serialized so saves are exact.
   */
  demandAcc: Int32Array
  /** Shared cadence countdown (ticks since the last evaluation). */
  timer: number
  /**
   * Per-village stage ladder, indexed by the dense village id (`ladders[i]` is village `i`'s
   * ladder). Each settlement has its own, so a mining camp climbs a shallow tier-1/2 ladder while a
   * spaceport climbs the deep aerospace one — the two grow and decline independently.
   */
  ladders: VillageStageConfig[][]
}

export function createVillageStore(): VillageStore {
  const cap = 4
  return {
    count: 0,
    vx: new Int32Array(cap),
    vy: new Int32Array(cap),
    stage: new Int32Array(cap),
    growthTimer: new Int32Array(cap),
    declineTimer: new Int32Array(cap),
    graceTimer: new Int32Array(cap),
    demandAcc: new Int32Array(cap * MAX_VILLAGE_DEMANDS),
    timer: 0,
    ladders: [],
  }
}

/** Register a village at anchor tile (x, y) climbing its own `stages` ladder. Returns its dense id. */
export function registerVillage(
  v: VillageStore,
  x: number,
  y: number,
  stages: VillageStageConfig[],
): number {
  const need = v.count + 1
  if (need > v.vx.length) {
    let next = v.vx.length
    while (next < need) next *= 2
    v.vx = grow(v.vx, next, 0)
    v.vy = grow(v.vy, next, 0)
    v.stage = grow(v.stage, next, 0)
    v.growthTimer = grow(v.growthTimer, next, 0)
    v.declineTimer = grow(v.declineTimer, next, 0)
    v.graceTimer = grow(v.graceTimer, next, 0)
    v.demandAcc = grow(v.demandAcc, next * MAX_VILLAGE_DEMANDS, 0)
  }
  const i = v.count++
  v.vx[i] = x
  v.vy[i] = y
  v.stage[i] = 0
  v.growthTimer[i] = 0
  v.declineTimer[i] = 0
  v.graceTimer[i] = VILLAGE_DECLINE_GRACE
  v.ladders[i] = stages
  for (let d = 0; d < MAX_VILLAGE_DEMANDS; d++) v.demandAcc[i * MAX_VILLAGE_DEMANDS + d] = 0
  return i
}

/** Current stage index (0-based) of the village anchored at (x, y), or NONE if none there. */
export function villageStageAt(v: VillageStore, x: number, y: number): number {
  for (let i = 0; i < v.count; i++) if (v.vx[i] === x && v.vy[i] === y) return v.stage[i]!
  return NONE
}

/** The current stage config of the village anchored at (x, y), or undefined if none there. */
export function villageStageConfigAt(
  v: VillageStore,
  x: number,
  y: number,
): VillageStageConfig | undefined {
  for (let i = 0; i < v.count; i++) {
    if (v.vx[i] === x && v.vy[i] === y) return v.ladders[i]?.[v.stage[i]!]
  }
  return undefined
}

/** Units of `color` currently stocked in building `b`'s buffer (0 if it stocks none). Bounded scan. */
function villageBufferAmount(store: BuildingStore, b: number, color: number): number {
  const n = store.slotN[b]!
  for (let k = 0; k < n; k++) {
    const i = b * MAX_SLOTS + k
    if (store.slotColor[i] === color) return store.slotCount[i]!
  }
  return 0
}

/** Consume `need` of `color` from building `b`'s buffer; returns true if the buffer covered it. */
function consumeFromBuffer(store: BuildingStore, b: number, color: number, need: number): boolean {
  const n = store.slotN[b]!
  for (let k = 0; k < n; k++) {
    const i = b * MAX_SLOTS + k
    if (store.slotColor[i] !== color) continue
    const have = store.slotCount[i]!
    if (have >= need) {
      store.slotCount[i] = have - need
      return true
    }
    store.slotCount[i] = 0 // eat what's there; the demand is still unmet.
    return false
  }
  return false // the village doesn't even stock this resource yet.
}

/** Zero every fractional-demand accumulator of village `i` (on a stage change). */
function resetDemandAcc(v: VillageStore, i: number): void {
  const base = i * MAX_VILLAGE_DEMANDS
  for (let d = 0; d < MAX_VILLAGE_DEMANDS; d++) v.demandAcc[base + d] = 0
}

/**
 * Advance every village once per {@link VILLAGE_CADENCE} ticks: accrue each current-stage demand's
 * fractional need, consume any whole units now due from the village buffer, then move a growth/decline
 * timer. A demand accrues `ratePerMin * VILLAGE_CADENCE` unit·ticks each cadence and owes one unit per
 * {@link VILLAGE_TICKS_PER_MIN} accrued, so its rate is honoured exactly (a cadence with nothing yet due
 * counts as met). The stages list demands cumulatively, so a missing low-tier good starves the higher
 * tiers too; every current demand met accrues the growth timer and clears decline, any unmet accrues
 * decline and clears growth. A full growth timer advances a stage (capped at the top); a full decline
 * timer drops one (floored at 0 — never removed); either resets the accumulators. Integer math, no RNG.
 */
function updateVillages(state: GameState): void {
  const v = state.villages
  if (v.count === 0) return
  if (++v.timer < VILLAGE_CADENCE) return
  v.timer = 0
  const store = state.buildings
  for (let i = 0; i < v.count; i++) {
    const stages = v.ladders[i]!
    if (stages.length === 0) continue // a village with no ladder never grows or declines.
    const b = buildingAt(store, v.vx[i]!, v.vy[i]!)
    if (b === NONE) continue // the village building was removed — leave the entry inert.
    const cfg = stages[v.stage[i]!]!
    const accBase = i * MAX_VILLAGE_DEMANDS
    let allMet = true
    for (let d = 0; d < cfg.demands.length && d < MAX_VILLAGE_DEMANDS; d++) {
      const dem = cfg.demands[d]!
      const ai = accBase + d
      const acc = v.demandAcc[ai]! + dem.ratePerMin * VILLAGE_CADENCE
      const due = Math.floor(acc / VILLAGE_TICKS_PER_MIN)
      // Advance the clock by the whole units owed regardless of coverage (bounded — no runaway debt).
      v.demandAcc[ai] = acc - due * VILLAGE_TICKS_PER_MIN
      if (due > 0) {
        // A unit fell due this cadence: draw it, and a shortfall is a miss.
        if (!consumeFromBuffer(store, b, dem.color, due)) allMet = false
      } else if (dem.ratePerMin > 0 && villageBufferAmount(store, b, dem.color) === 0) {
        // Nothing due yet, but an empty buffer of a demanded good is a starved miss — otherwise a
        // low rate (whole units due only every few cadences) would look satisfied while starving.
        allMet = false
      }
    }
    if (allMet) {
      // First full supply ends the startup grace: from here the village declines normally if starved.
      v.graceTimer[i] = 0
      v.declineTimer[i] = 0
      v.growthTimer[i] = v.growthTimer[i]! + VILLAGE_CADENCE
    } else if (v.graceTimer[i]! > 0) {
      // Still within startup grace: burn it down but neither accrue decline nor raise the alert, so a
      // just-founded settlement doesn't nag before the player can plausibly route supply to it.
      v.graceTimer[i] = Math.max(0, v.graceTimer[i]! - VILLAGE_CADENCE)
      v.growthTimer[i] = 0
      v.declineTimer[i] = 0
    } else {
      v.growthTimer[i] = 0
      v.declineTimer[i] = v.declineTimer[i]! + VILLAGE_CADENCE
    }
    if (v.growthTimer[i]! >= VILLAGE_GROWTH_AFTER && v.stage[i]! < stages.length - 1) {
      v.stage[i] = v.stage[i]! + 1
      v.growthTimer[i] = 0
      v.declineTimer[i] = 0
      resetDemandAcc(v, i)
    } else if (v.declineTimer[i]! >= VILLAGE_DECLINE_AFTER && v.stage[i]! > 0) {
      v.stage[i] = v.stage[i]! - 1
      v.growthTimer[i] = 0
      v.declineTimer[i] = 0
      resetDemandAcc(v, i)
    }
  }
}

// --- Research ---------------------------------------------------------------

/**
 * How often the research system runs (ticks). Like villages, research changes slowly, so packs
 * are drained from labs once per cadence rather than every tick — keeping the per-tick cost near
 * zero. At 60 tps this is one evaluation per second.
 */
export const RESEARCH_CADENCE = 60

/** "No active technology" sentinel for {@link ResearchStore.activeTech}; {@link techTypeOf} never returns it. */
export const RESEARCH_NONE = 0

/**
 * Max distinct research-pack types a single technology's `cost` can list (the science-pack
 * palette). Fixed so the per-pack cost/progress live in flat typed arrays, allocation-free.
 */
export const MAX_RESEARCH_COST = 8

/**
 * The live research progression, owned by the base game (not the engine). A single technology is
 * "active" at a time ({@link ResearchStore.activeTech}, an opaque integer id — see
 * {@link techTypeOf}); every {@link RESEARCH_CADENCE} ticks the {@link updateResearch} system
 * drains research packs from every registered *lab* (a store building holding packs) toward the
 * active tech's `cost`, then records it complete and goes idle. The cost is **per pack type**: a
 * tech may require several distinct science packs (each an item colour + amount), and every one
 * must be met — so a factory that makes only some of the packs stalls research the way Factorio's
 * science tiers gate progress. The sim knows nothing tech-specific: the host supplies the active
 * tech's integer id and its per-pack cost through the `set_active_research` command, and reads the
 * completed integer ids back to drive the buildable set. Labs are anchored by tile (re-resolved to
 * a building id each cadence) so the store survives building-store compaction, like villages.
 */
export interface ResearchStore {
  /** Number of registered labs. */
  labCount: number
  /** Lab anchor tiles (top-left of the lab footprint). */
  lx: Int32Array
  ly: Int32Array
  /** Active technology integer id, or {@link RESEARCH_NONE} when idle. */
  activeTech: number
  /** Number of active per-pack cost entries (<= {@link MAX_RESEARCH_COST}). */
  costN: number
  /** Per-entry pack colour required by the active tech. */
  costColor: Int32Array
  /** Per-entry pack amount required. */
  costAmount: Int32Array
  /** Per-entry packs accumulated so far (parallel to {@link costColor}). */
  progress: Int32Array
  /** Integer ids of technologies completed at runtime (in completion order). */
  completed: number[]
  /** Shared cadence countdown (ticks since the last evaluation). */
  timer: number
}

export function createResearchStore(): ResearchStore {
  const cap = 4
  return {
    labCount: 0,
    lx: new Int32Array(cap),
    ly: new Int32Array(cap),
    activeTech: RESEARCH_NONE,
    costN: 0,
    costColor: new Int32Array(MAX_RESEARCH_COST),
    costAmount: new Int32Array(MAX_RESEARCH_COST),
    progress: new Int32Array(MAX_RESEARCH_COST),
    completed: [],
    timer: 0,
  }
}

/** Register a lab at anchor tile (x, y). Its pack buffer lives in the building store keyed by that tile. */
export function registerResearchLab(r: ResearchStore, x: number, y: number): number {
  const need = r.labCount + 1
  if (need > r.lx.length) {
    let next = r.lx.length
    while (next < need) next *= 2
    r.lx = grow(r.lx, next, 0)
    r.ly = grow(r.ly, next, 0)
  }
  const i = r.labCount++
  r.lx[i] = x
  r.ly[i] = y
  return i
}

/** True once the technology with integer id `tech` has been researched. */
export function researchCompleted(r: ResearchStore, tech: number): boolean {
  for (let i = 0; i < r.completed.length; i++) if (r.completed[i] === tech) return true
  return false
}

/**
 * Drain up to `max` packs of colour `color` out of building `b`'s drainable slots, returning the
 * amount removed. A lab holds each pack type in its own slot, so this pulls only the matching
 * colour (fixed slot order) toward the active tech without ever exceeding what is still needed.
 * Integer math, allocation-free.
 */
function drainResearchPacks(store: BuildingStore, b: number, color: number, max: number): number {
  if (max <= 0) return 0
  const n = store.slotN[b]!
  let taken = 0
  for (let k = 0; k < n && taken < max; k++) {
    const i = b * MAX_SLOTS + k
    if (!(store.slotRole[i]! & ROLE_DRAIN)) continue
    if (store.slotColor[i]! !== color) continue
    const want = max - taken
    const have = store.slotCount[i]!
    const pull = have < want ? have : want
    store.slotCount[i] = have - pull
    taken += pull
  }
  return taken
}

/**
 * Advance research once per {@link RESEARCH_CADENCE} ticks: while a technology is active, drain
 * each required pack type from every registered lab toward its per-pack target (never past it —
 * leftover packs stay in the lab). When **every** pack cost is met, record the tech complete and
 * go idle (single-active model — the host selects the next tech). A tech with no cost completes on
 * the next evaluation. Integer math, no RNG; runs off the per-tick hot path.
 */
function updateResearch(state: GameState): void {
  const r = state.research
  if (r.activeTech === RESEARCH_NONE) return
  if (++r.timer < RESEARCH_CADENCE) return
  r.timer = 0
  const store = state.buildings
  let complete = true
  for (let c = 0; c < r.costN; c++) {
    const need = r.costAmount[c]! - r.progress[c]!
    if (need <= 0) continue
    const color = r.costColor[c]!
    let got = 0
    for (let i = 0; i < r.labCount && got < need; i++) {
      const b = buildingAt(store, r.lx[i]!, r.ly[i]!)
      if (b === NONE) continue // the lab building was removed — leave the anchor inert.
      got += drainResearchPacks(store, b, color, need - got)
    }
    r.progress[c] = r.progress[c]! + got
    if (r.progress[c]! < r.costAmount[c]!) complete = false
  }
  if (complete) {
    r.completed.push(r.activeTech)
    r.activeTech = RESEARCH_NONE
    r.costN = 0
  }
}

/** Plain, JSON-safe capture of a {@link ResearchStore} for save/load round-trips. */
export interface ResearchSnapshot {
  readonly labs: readonly { readonly x: number; readonly y: number }[]
  readonly activeTech: number
  /** Active per-pack cost: colour, required amount, and packs accumulated so far. */
  readonly cost: readonly {
    readonly color: number
    readonly amount: number
    readonly progress: number
  }[]
  readonly completed: readonly number[]
  readonly timer: number
}

/** Capture the research store as a plain snapshot (see {@link deserializeResearch}). */
export function serializeResearch(r: ResearchStore): ResearchSnapshot {
  const labs: { x: number; y: number }[] = []
  for (let i = 0; i < r.labCount; i++) labs.push({ x: r.lx[i]!, y: r.ly[i]! })
  const cost: { color: number; amount: number; progress: number }[] = []
  for (let c = 0; c < r.costN; c++) {
    cost.push({ color: r.costColor[c]!, amount: r.costAmount[c]!, progress: r.progress[c]! })
  }
  return { labs, activeTech: r.activeTech, cost, completed: r.completed.slice(), timer: r.timer }
}

/** Load a research snapshot into an existing store in place (systems close over the store). */
export function loadResearchSnapshot(r: ResearchStore, snap: ResearchSnapshot): void {
  r.labCount = 0
  for (const lab of snap.labs) registerResearchLab(r, lab.x, lab.y)
  r.activeTech = snap.activeTech
  r.costN = Math.min(snap.cost.length, MAX_RESEARCH_COST)
  for (let c = 0; c < r.costN; c++) {
    r.costColor[c] = snap.cost[c]!.color
    r.costAmount[c] = snap.cost[c]!.amount
    r.progress[c] = snap.cost[c]!.progress
  }
  r.completed = snap.completed.slice()
  r.timer = snap.timer
}

/** Rebuild a research store from a snapshot. Inverse of {@link serializeResearch}. */
export function deserializeResearch(snap: ResearchSnapshot): ResearchStore {
  const r = createResearchStore()
  loadResearchSnapshot(r, snap)
  return r
}

// --- Per-tick systems -------------------------------------------------------

/**
 * Advance items one tile in downstream-first order, then let inputs deposit what arrived
 * into their linked building. Processing sinks before their feeders means a tile is vacated
 * before the tile behind it is visited, so a packed run shuffles forward one tile in a
 * single pass.
 */
function stepBelts(
  gw: GameWorld,
  api: ModApi,
  g: BeltGrid,
  store: BuildingStore,
  treasury: TreasuryStore,
  prices: PriceTable,
): void {
  const { order, slot, kind, nbr, face, inDir, rr, tx, ty, dueEvery, portBuilding } = g
  const { Position, Renderable } = gw.components
  const n = g.count
  const moveCount = g.moveCount

  // Park every riding item's render anchor on its own tile first: by default an item is
  // stationary this cycle. Movers overwrite their anchor below. Without this, a blocked or
  // backed-up item keeps the prev* tile it last stepped from, so the renderer re-plays that
  // one-tile slide every cycle and snaps back — items appear to jitter into each other. The
  // prev*/x/y writes here are the render anchor only (prev* are never hashed).
  for (let i = 0; i < n; i++) {
    const t = order[i]!
    const eid = slot[t]!
    if (eid === NONE) continue
    Position.prevX[eid] = tx[t]!
    Position.prevY[eid] = ty[t]!
    Position.x[eid] = tx[t]!
    Position.y[eid] = ty[t]!
  }

  // Inputs deposit the item sitting on their tile into the building they feed, if it accepts
  // that resource (matched by colour) and has room. Otherwise the item stays put and backs the
  // belt up (an unlinked input, an unaccepted resource, or a full slot all block).
  //
  // This runs *before* the move pass so it only ever consumes an item that arrived on the input
  // tile in an EARLIER cycle: the move pass below slides an item onto the input tile and lets it
  // glide there over a whole move-cycle (prev=feeder tile, x=input tile), and only the next
  // cycle's deposit absorbs it. Depositing in the same pass the item arrived would despawn it
  // before the renderer ever drew it on the port, so the item appeared to vanish one tile short
  // of the building instead of riding into it.
  for (let t = 0; t < n; t++) {
    if (kind[t] !== KIND_INPUT || slot[t] === NONE) continue
    const b = portBuilding[t]!
    if (b === NONE) continue
    const eid = slot[t]!
    const color = Renderable.color[eid]!
    // A filtered input only ingests colours its whitelist/blacklist admits; a rejected item stays
    // put and backs the belt up (same as an unaccepted resource) so the player can sort a mixed line.
    if (!portFilterPasses(g, t, color)) continue
    // A depot is a wildcard sales sink: any arriving item is sold, crediting its market price (no
    // slot, no capacity), refilling the credit balance. Depots hold no stock, so this never blocks.
    if (store.depot[b]) {
      creditTreasury(treasury, priceOf(prices, color))
      api.despawn(eid)
      slot[t] = NONE
      continue
    }
    const k = findSlot(store, b, color)
    if (k === NONE) continue
    const si = b * MAX_SLOTS + k
    if (store.slotCount[si]! >= store.slotCap[si]!) continue
    store.slotCount[si] = store.slotCount[si]! + 1
    api.despawn(eid)
    slot[t] = NONE
  }

  for (let i = 0; i < n; i++) {
    const t = order[i]!
    const eid = slot[t]!
    if (eid === NONE || kind[t] === KIND_INPUT) continue
    // This tile's item only advances on the tile's own cadence; off-cadence it stays parked
    // (the loop above already pinned its render anchor), letting slower tiers coexist with fast ones.
    if (moveCount % dueEvery[t]! !== 0) continue

    let target = NONE
    let dir = NONE
    if (kind[t] === KIND_SPLITTER) {
      const src = inDir[t] === NONE ? NONE : opposite(inDir[t]!)
      for (let j = 0; j < 4; j++) {
        const d = (rr[t]! + j) & 3
        const nb = nbr[t * 4 + d]!
        if (nb !== NONE && d !== src && slot[nb] === NONE) {
          target = nb
          dir = d
          rr[t] = (d + 1) & 3
          break
        }
      }
    } else {
      const d = face[t]!
      const nb = nbr[t * 4 + d]!
      if (nb !== NONE && slot[nb] === NONE) {
        target = nb
        dir = d
      }
    }

    if (target !== NONE) {
      slot[target] = eid
      slot[t] = NONE
      inDir[target] = dir
      // Glide from the tile we left (prev*) to the destination (x/y) over the move-cycle
      // (see beltMoveAlpha). Sim truth stays the integer destination tile.
      Position.prevX[eid] = tx[t]!
      Position.prevY[eid] = ty[t]!
      Position.x[eid] = tx[target]!
      Position.y[eid] = ty[target]!
    }
  }
}

/**
 * Run every crafter's recipe. A crafter attempts one craft every `craftEvery` ticks: it fires
 * only when every deposit (input) slot holds at least its recipe `amt` and every drain (output)
 * slot has room for its `amt` (capped — a full output blocks the craft). On a fire it subtracts
 * the inputs and adds the outputs. An *extraction* recipe (a farm/mine) has no input slots, so
 * it reduces to "make one unit into the output slot every craftEvery ticks", capped. When a
 * craft cannot fire the timer holds at the cadence so it retries as soon as inputs arrive / room
 * frees. Runs every tick, independent of the belt move cadence; allocation-free.
 *
 * A finite-deposit extractor (a crafter tagged with a cached `anchorKey`) additionally gates on the
 * remaining richness under its anchor tile: an EXHAUSTED tile (0 left) stalls it exactly like a
 * missing input, and every completed extraction decrements the tile by the units produced. Crossing
 * to zero greys the deposit's terrain entity in place. Ordinary machines (anchorKey === NONE) skip
 * all of this — the richness Map is never touched for them.
 */
/**
 * Pooled richness a finite extractor `b` can draw on: the sum of remaining units across every deposit
 * tile of its resource within reach (its footprint expanded by {@link EXTRACTOR_REACH}). Returns
 * {@link RICHNESS_INFINITE} for an ordinary machine (no anchor), an anchor that lost its terrain, or
 * when any covered deposit is itself infinite — in every one of those cases the machine never depletes.
 * The resource terrain type is read from the extractor's cached anchor tile. Allocation-free bounded
 * scan (coverage is a footprint plus a one-tile ring), matching {@link extractorAnchorInReach}'s order.
 */
function extractorReserve(
  store: BuildingStore,
  b: number,
  terrain: TerrainGrid,
  deposits: DepositStore,
): number {
  const ak = store.anchorKey[b]!
  if (ak === NONE) return RICHNESS_INFINITE
  const resource = terrain.get(ak)
  if (resource === undefined) return RICHNESS_INFINITE
  const x = store.bx[b]!
  const y = store.by[b]!
  const w = store.bw[b]!
  const h = store.bh[b]!
  let pooled = 0
  for (let ty = y - EXTRACTOR_REACH; ty < y + h + EXTRACTOR_REACH; ty++) {
    for (let tx = x - EXTRACTOR_REACH; tx < x + w + EXTRACTOR_REACH; tx++) {
      if (terrain.get(tileKey(tx, ty)) !== resource) continue
      const r = deposits.remaining.get(tileKey(tx, ty))
      if (r === undefined) return RICHNESS_INFINITE // a covered infinite deposit — never depletes
      pooled += r
    }
  }
  return pooled
}

/**
 * Draw `amount` units from extractor `b`'s covered deposit tiles — its footprint expanded by
 * {@link EXTRACTOR_REACH}, scanned row-major, taking as much as each non-empty tile holds before
 * spilling to the next — and grey each deposit's terrain entity the instant it exhausts. The mirror
 * of the pooled read in {@link extractorReserve}; called only when that read confirmed finite stock.
 */
function depleteExtractor(
  gw: GameWorld,
  store: BuildingStore,
  b: number,
  terrain: TerrainGrid,
  deposits: DepositStore,
  amount: number,
): void {
  const resource = terrain.get(store.anchorKey[b]!)
  if (resource === undefined) return
  const x = store.bx[b]!
  const y = store.by[b]!
  const w = store.bw[b]!
  const h = store.bh[b]!
  let left = amount
  for (let ty = y - EXTRACTOR_REACH; ty < y + h + EXTRACTOR_REACH && left > 0; ty++) {
    for (let tx = x - EXTRACTOR_REACH; tx < x + w + EXTRACTOR_REACH && left > 0; tx++) {
      const key = tileKey(tx, ty)
      if (terrain.get(key) !== resource) continue
      const r = deposits.remaining.get(key)
      if (r === undefined || r <= RICHNESS_EXHAUSTED) continue
      const take = r < left ? r : left
      const rest = r - take
      deposits.remaining.set(key, rest)
      left -= take
      if (rest === RICHNESS_EXHAUSTED) {
        const teid = deposits.eid.get(key)
        if (teid !== undefined) gw.components.Renderable.color[teid] = EXHAUSTED_COLOR
      }
    }
  }
}

function runCrafters(
  gw: GameWorld,
  api: ModApi,
  store: BuildingStore,
  deposits: DepositStore,
  terrain: TerrainGrid,
): void {
  const n = store.count
  for (let b = 0; b < n; b++) {
    // A pure store (no recipe) never "works": make sure it carries no leftover active pulse
    // (e.g. a crafter whose recipe was just cleared).
    if (!store.crafts[b]) {
      api.setActive(store.eid[b]!, false)
      continue
    }
    const timer = store.craftTimer[b]! + 1
    if (timer < store.craftEvery[b]!) {
      // Mid-cycle: leave the active pulse as the last fire set it, so a working crafter keeps
      // pulsing between cadence ticks instead of flickering.
      store.craftTimer[b] = timer
      continue
    }
    // Cadence reached — can we fire? Inputs (deposit slots with amt) need enough; outputs
    // (drain slots with amt) need room. A slot is a recipe slot iff its amt > 0.
    const base = b * MAX_SLOTS
    const slotN = store.slotN[b]!
    let canCraft = true
    for (let k = 0; k < slotN; k++) {
      const i = base + k
      const amt = store.slotAmt[i]!
      if (amt === 0) continue
      if (store.slotRole[i]! & ROLE_DEPOSIT) {
        if (store.slotCount[i]! < amt) {
          canCraft = false
          break
        }
      } else if (store.slotCount[i]! + amt > store.slotCap[i]!) {
        canCraft = false
        break
      }
    }
    // Finite-deposit gate: pool the richness across every matching deposit tile in the extractor's
    // reach (its footprint plus a one-tile ring). `rem` stays RICHNESS_INFINITE (-1) for ordinary
    // machines and infinite/legacy deposits, which never deplete; an all-exhausted area stalls it.
    let rem = RICHNESS_INFINITE
    const ak = store.anchorKey[b]!
    if (ak !== NONE) {
      rem = extractorReserve(store, b, terrain, deposits)
      if (rem !== RICHNESS_INFINITE && rem <= RICHNESS_EXHAUSTED) canCraft = false // area spent: stall
    }
    if (!canCraft) {
      // Hold the timer at the cadence so we retry next tick without re-accumulating.
      store.craftTimer[b] = store.craftEvery[b]!
      // Starved/backed-up/exhausted: stop the working pulse so the machine reads as stalled.
      api.setActive(store.eid[b]!, false)
      continue
    }
    store.craftTimer[b] = 0
    let extracted = 0
    for (let k = 0; k < slotN; k++) {
      const i = base + k
      const amt = store.slotAmt[i]!
      if (amt === 0) continue
      if (store.slotRole[i]! & ROLE_DEPOSIT) store.slotCount[i] = store.slotCount[i]! - amt
      else {
        store.slotCount[i] = store.slotCount[i]! + amt
        extracted += amt // units pulled from the deposit this craft (recipe outputs)
      }
    }
    // Deplete the covered deposits of a finite extractor by what it produced (spilling tile to tile),
    // greying each on exhaustion. `rem > 0` only when the anchored area holds finite, non-empty stock.
    if (rem > RICHNESS_EXHAUSTED) depleteExtractor(gw, store, b, terrain, deposits, extracted)
    // Fired this cadence: mark it working. Stays set through the accumulation ticks above.
    api.setActive(store.eid[b]!, true)
  }
}

/**
 * Output ports drain one unit from their linked building onto their own belt tile every
 * `portEvery` ticks, but only when that tile is free — a full belt backs the port up. The
 * drained resource is the first non-empty stockpile slot (fixed slot order); the emitted item
 * carries that slot's colour. Allocation-free except for the occasional spawn. Runs every tick,
 * independent of the move cadence.
 */
function extractFromOutputs(api: ModApi, g: BeltGrid, store: BuildingStore): void {
  const { kind, slot, portTimer, portEvery, portBuilding } = g
  const n = g.count
  for (let t = 0; t < n; t++) {
    if (kind[t] !== KIND_OUTPUT) continue
    const timer = portTimer[t]! + 1
    if (timer < portEvery[t]!) {
      portTimer[t] = timer
      continue
    }
    // Cadence elapsed: this cycle is spent whether or not we emit (a blocked tile or an empty
    // building simply loses the cycle, matching the old extractor's back-up behaviour).
    portTimer[t] = 0
    if (slot[t] !== NONE) continue
    const b = portBuilding[t]!
    if (b === NONE) continue
    const k = firstDrainableForPort(store, b, g, t)
    if (k === NONE) continue
    const si = b * MAX_SLOTS + k
    store.slotCount[si] = store.slotCount[si]! - 1
    slot[t] = api.spawn({
      pos: { x: g.tx[t]!, y: g.ty[t]! },
      sprite: sprite(SHAPE_CIRCLE, 0),
      color: store.slotColor[si]!,
      width: 1,
      height: 1,
    })
    g.inDir[t] = NONE
  }
}

/**
 * Tick the whole game: move items on the move-cycle, then let crafters run their recipes into
 * their stores and output ports drain those stores onto the belts. Crafting runs before drain
 * so a unit made this tick can leave the same tick if the belt is free.
 */
function updateBelts(
  gw: GameWorld,
  api: ModApi,
  g: BeltGrid,
  store: BuildingStore,
  treasury: TreasuryStore,
  prices: PriceTable,
  deposits: DepositStore,
  terrain: TerrainGrid,
): void {
  if (++g.moveTimer >= g.moveEvery) {
    g.moveTimer = 0
    stepBelts(gw, api, g, store, treasury, prices)
    g.moveCount++
  }
  runCrafters(gw, api, store, deposits, terrain)
  extractFromOutputs(api, g, store)
}

// --- Game state -------------------------------------------------------------

// --- Prices: the host-computed colour → credit table ------------------------

/** Price used for a colour the host never priced (a raw with no recipe, or a synthetic test colour). */
export const DEFAULT_PRICE = 1

/**
 * The colour→price table the HOST computes from the recipe DAG at content-load time (see
 * `content.ts`'s `itemColorPrices`) and hands the sim through `base:ready`'s `setPrices` — exactly
 * how the other colour-keyed config reaches the sim (the sim never sees an item id). The sim looks
 * a colour up here to value a depot sale or a build cost in credits. Derived purely from content,
 * so it is identical on every load and NOT serialized: the host re-supplies it before applying the
 * scene or a save. The integer *credits* it produces ARE hashed, so determinism is preserved.
 */
export interface PriceTable {
  /** Resource colour → integer credit price (≥ 1). Absent colour → {@link DEFAULT_PRICE}. */
  readonly price: Map<number, number>
}

export function createPriceTable(): PriceTable {
  return { price: new Map() }
}

/** Integer credit price of one unit of resource `color` (≥ 1). Allocation-free Map lookup. */
export function priceOf(prices: PriceTable, color: number): number {
  const p = prices.price.get(color)
  return p !== undefined && p > 0 ? p : DEFAULT_PRICE
}

/** Replace the price table's entries in place (host call, before newGame/load). Off the hot path. */
export function loadPriceTable(
  prices: PriceTable,
  entries: readonly { readonly color: number; readonly price: number }[],
): void {
  prices.price.clear()
  for (const e of entries) prices.price.set(e.color, Math.max(1, Math.floor(e.price)))
}

// --- Treasury: the single-currency credit balance (G6) ----------------------

/**
 * The global CREDIT balance the player spends to place buildings and earns by selling goods into a
 * *depot* (see {@link BuildingStore.depot}). This replaced the old per-colour bank: one integer
 * currency instead of a stockpile keyed by resource colour. A placement is charged the credit value
 * of its `buildCost` (Σ amount × the item's {@link PriceTable} price); a depot deposit credits the
 * sold item's price; and a slow upkeep sink ({@link UPKEEP_CADENCE}) drains a little each cadence,
 * floored at zero. Owned by the base game (not the engine); every mutation is off the per-tick hot
 * path, and the two integers serialize byte-identically.
 */
export interface TreasuryStore {
  /** Current credit balance (never negative). */
  credits: number
  /** Ticks accumulated toward the next upkeep drain (see {@link UPKEEP_CADENCE}). */
  upkeepTimer: number
}

export function createTreasuryStore(): TreasuryStore {
  return { credits: 0, upkeepTimer: 0 }
}

/**
 * How often the upkeep sink runs (ticks): every 30 s of sim time at 60 tps. Buildings that carry a
 * per-type `upkeep` (the big machines — see {@link BuildingStore.upkeep}) drain their cost from the
 * credit balance once per cadence. At zero credits nothing stalls — the balance just floors at 0 —
 * so upkeep is economic pressure, never a hard failure. Slow cadence keeps the per-tick cost nil.
 */
export const UPKEEP_CADENCE = 1800

/** Current credit balance. */
export function treasuryCredits(t: TreasuryStore): number {
  return t.credits
}

/** Add `amount` (≥ 0) credits to the balance. Off the hot path (a depot sale, a refund, a seed). */
export function creditTreasury(t: TreasuryStore, amount: number): void {
  if (amount > 0) t.credits += amount
}

/** One line of a build cost / refund: a resource colour and how many units. */
export interface CostEntry {
  readonly color: number
  readonly amount: number
}

/** The credit value of `cost`: Σ amount × unit price. Integer (prices and amounts are integers). */
export function costCredits(prices: PriceTable, cost: readonly CostEntry[]): number {
  let total = 0
  for (let a = 0; a < cost.length; a++) total += cost[a]!.amount * priceOf(prices, cost[a]!.color)
  return total
}

/**
 * The upkeep sink (G6): once per {@link UPKEEP_CADENCE} ticks, drain every building's per-type
 * `upkeep` from the credit balance, floored at zero. Nothing stalls at zero credits — upkeep is
 * pressure, not a hard failure — and the drain is a single integer subtraction per cadence.
 * Between cadences the per-tick cost is one integer increment and compare. No alert is raised when
 * upkeep outruns income (deliberately skipped this pass — the balance visibly sagging in the HUD
 * is the signal; a rate-aware alert can come later if that proves too quiet).
 */
function updateUpkeep(state: GameState): void {
  const t = state.treasury
  if (++t.upkeepTimer < UPKEEP_CADENCE) return
  t.upkeepTimer = 0
  const store = state.buildings
  let due = 0
  for (let b = 0; b < store.count; b++) due += store.upkeep[b]!
  if (due > 0) t.credits = t.credits > due ? t.credits - due : 0
}

/** True if the balance can cover the credit value of `cost`. Off the hot path. */
export function canAffordTreasury(
  t: TreasuryStore,
  prices: PriceTable,
  cost: readonly CostEntry[],
): boolean {
  return t.credits >= costCredits(prices, cost)
}

/** Deduct the credit value of `cost` (clamped at 0). Call only after {@link canAffordTreasury}. */
export function spendTreasury(
  t: TreasuryStore,
  prices: PriceTable,
  cost: readonly CostEntry[],
): void {
  t.credits = Math.max(0, t.credits - costCredits(prices, cost))
}

// --- Game config: new-game settings that tune the rules ---------------------

/**
 * Per-game tunables chosen at new-game time and carried in the (serialized) {@link GameState} so
 * they survive save/load and stay deterministic. Kept as a small struct so future settings (build
 * refund is the first) are added additively without threading new params through the sim.
 */
/**
 * The scenario win goal (G5): reach a target settlement's stage. Authored on the scenario as
 * `{ village, stage }` (a village prototype id + a 0-based stage index); the scene resolves the
 * village to its anchor tile ({@link GameGoal.vx}/{@link GameGoal.vy}) at new-game time and stores
 * the whole thing in {@link GameConfig.goal}, so a read-only selector ({@link goalStatus}) can
 * compare the target village's live stage against the requirement without the sim tracking
 * prototype ids. Deliberately a small struct so a later "deliver N of an item" variant can slot in
 * additively (a discriminated shape) without reworking the config plumbing.
 */
export interface GameGoal {
  /** The target settlement's village prototype id (the host resolves it to a display name). */
  readonly village: string
  /** Required 0-based stage index the target village must reach to win. */
  readonly stage: number
  /** Resolved anchor tile of the target village (top-left of its footprint), set at scene time. */
  readonly vx: number
  readonly vy: number
}

export interface GameConfig {
  /**
   * Fraction of a building's `buildCost` returned to the treasury when it is removed, in permille
   * (1000 = full refund, 0 = none). Integer so the refund math stays exact and deterministic.
   */
  buildRefundPermille: number
  /**
   * The scenario win goal, resolved to its target village tile at new-game time (see {@link GameGoal}).
   * Absent when the scenario declares no goal. Carried in the save so a load restores the objective —
   * a session that loads an already-won world can tell, without replaying how it got there.
   */
  goal?: GameGoal
}

/** The default rules: full (100%) build refund, and no win goal (a scenario opts in). */
export function createGameConfig(): GameConfig {
  return { buildRefundPermille: 1000 }
}

/**
 * Refund the credit value of `refund` scaled by the config's permille into the treasury (used on
 * removal). The whole credit total is scaled then floored, so the refund stays an exact integer.
 */
export function refundTreasury(
  t: TreasuryStore,
  config: GameConfig,
  prices: PriceTable,
  refund: readonly CostEntry[],
): void {
  const per = Math.max(0, config.buildRefundPermille)
  creditTreasury(t, Math.floor((costCredits(prices, refund) * per) / 1000))
}

export interface GameState {
  /** The belt network. */
  readonly grid: BeltGrid
  /** The passive terrain layer that gates where crafters may be built. */
  readonly terrain: TerrainGrid
  /**
   * Terrain types nothing can be built on (impassable biomes like water). Derived from the content
   * and re-supplied each new-game/load (not serialized), like {@link GameState.prices}.
   */
  readonly blockingTerrain: BlockingTerrain
  /** Finite deposit richness: units remaining under each deposit tile (absent = infinite). */
  readonly deposits: DepositStore
  /** The resource-holding buildings (crafters and stores). */
  readonly buildings: BuildingStore
  /** The villages — staged demand consumers that grow/decline on how well they are supplied. */
  readonly villages: VillageStore
  /** The live research progression — labs consume packs to complete the active technology. */
  readonly research: ResearchStore
  /** The single-currency credit balance spent on placement and earned at depots. */
  readonly treasury: TreasuryStore
  /**
   * Colour → credit price table (host-computed from the recipe DAG, re-supplied each load; not
   * serialized). The sim reads it to value build costs and depot sales in credits.
   */
  readonly prices: PriceTable
  /** Cargo cannons — long-haul artillery firing resource payloads to their linked silos. */
  readonly cannons: CannonStore
  /** Shells in flight from cannons to silos (transient projectiles). */
  readonly shells: ShellStore
  /** New-game rule settings (build refund, …) — carried here so they save and stay deterministic. */
  readonly config: GameConfig
}

export function createGameState(moveEvery = 60): GameState {
  return {
    grid: createBeltGrid(moveEvery),
    terrain: new Map(),
    blockingTerrain: new Set(),
    deposits: createDepositStore(),
    buildings: createBuildingStore(),
    villages: createVillageStore(),
    research: createResearchStore(),
    treasury: createTreasuryStore(),
    prices: createPriceTable(),
    cannons: createCannonStore(),
    shells: createShellStore(),
    config: createGameConfig(),
  }
}

// --- Save / load: mod-owned GameState serialization -------------------------

/**
 * The minimal entity shape the load path re-spawns — structurally identical to the engine's
 * `EntitySnapshot`. Declared locally so the sandboxed sim depends only on a *type*, never a
 * value import from the engine's persistence module (the base game reaches the engine solely
 * through {@link ModApi}). The host passes the snapshot's `entities` list straight through.
 */
export interface EntityData {
  readonly x: number
  readonly y: number
  readonly sprite: number
  readonly color: number
  readonly width: number
  readonly height: number
}

/**
 * One belt tile's sim state. The tile's entities (track arrow, port/splitter overlay, riding
 * item) are re-linked from the re-spawned world by tile + sprite-class on load, so no entity
 * ids are stored here. `nbr`/`order`/`dueEvery`/`moveEvery` are recomputed on rebuild.
 */
export interface BeltTileSnapshot {
  readonly tx: number
  readonly ty: number
  readonly face: number
  readonly kind: number
  readonly inDir: number
  readonly portTimer: number
  readonly portEvery: number
  readonly rr: number
  readonly period: number
  /**
   * Underground-cap partner tile id (a dense belt-tile index, which is stable across a round-trip
   * since tiles are serialized and rebuilt in the same dense order). NONE for an ordinary tile;
   * absent in pre-underground saves → treated as NONE (no tunnel).
   */
  readonly partner?: number
  /** Port colour-filter mode; absent in pre-filter saves → treated as FILTER_NONE. */
  readonly filterMode?: number
  /** Port filter colours (length {@link MAX_PORT_FILTER}); absent in pre-filter saves → no filter. */
  readonly filterColor?: readonly number[]
}

/** The belt grid: its live tiles plus the mid-cadence move counters that pace them. */
export interface BeltSnapshot {
  readonly tiles: readonly BeltTileSnapshot[]
  readonly moveTimer: number
  readonly moveCount: number
}

/** One stockpile slot, plain form (colour + current count + cap + role bits + recipe amount). */
export interface SlotSnapshot {
  readonly color: number
  readonly count: number
  readonly cap: number
  readonly role: number
  readonly amt: number
}

/** One building: footprint, crafter cadence/timer, and its stockpile slots. */
export interface BuildingSnapshot {
  readonly bx: number
  readonly by: number
  readonly bw: number
  readonly bh: number
  readonly crafts: number
  /** 1 if this building is a treasury depot. Absent in pre-treasury saves → treated as 0. */
  readonly depot?: number
  /** 1 if this building is a cannon silo. Absent in pre-cannon saves → treated as 0. */
  readonly silo?: number
  /** The crafter's recipe id (0 = empty machine). Absent in pre-recipe saves → treated as 0. */
  readonly recipe?: number
  /**
   * Cached deposit anchor tile key of a finite-deposit extractor, or absent for any other building
   * (and in pre-richness saves → treated as {@link NONE}, so a legacy extractor simply never depletes).
   */
  readonly anchorKey?: number
  /** Per-building upkeep in credits (G6). Absent in pre-upkeep saves → treated as 0 (free). */
  readonly upkeep?: number
  readonly craftEvery: number
  readonly craftTimer: number
  readonly slots: readonly SlotSnapshot[]
}

/** One village's anchor tile, its own stage ladder, current stage, timers, and demand accumulators. */
export interface VillageEntrySnapshot {
  readonly vx: number
  readonly vy: number
  readonly stage: number
  readonly growthTimer: number
  readonly declineTimer: number
  /**
   * Remaining startup-grace ticks (see {@link VILLAGE_DECLINE_GRACE}). Absent in pre-grace saves →
   * loads as 0, i.e. no grace, which is correct for an already-running world.
   */
  readonly graceTimer?: number
  /** Per-demand accumulators (length {@link MAX_VILLAGE_DEMANDS}) so consumption resumes exactly. */
  readonly demandAcc: readonly number[]
  /**
   * This village's own stage ladder (distinct settlements climb different demand ladders). Absent in
   * pre-multi-village saves → falls back to the snapshot's legacy shared {@link VillageSnapshot.stages}.
   */
  readonly stages?: readonly VillageStageConfig[]
}

/** The villages: the cadence countdown and the per-village entries (each carrying its own ladder). */
export interface VillageSnapshot {
  /**
   * Legacy shared stage ladder from pre-multi-village saves (every village used one). New saves carry
   * the ladder per {@link VillageEntrySnapshot.stages} and omit this; kept optional so an old save
   * still loads — its entries fall back to it.
   */
  readonly stages?: readonly VillageStageConfig[]
  readonly timer: number
  readonly entries: readonly VillageEntrySnapshot[]
}

/**
 * The treasury: the single credit balance plus the upkeep cadence timer (G6). Byte-identical
 * round-trip. The optional `entries` field is the LEGACY per-colour bank (pre-G6) — present only in
 * old saves; see {@link loadTreasurySnapshot} for how it is converted to credits.
 */
export interface TreasurySnapshot {
  /** Credit balance. Absent only in a legacy per-colour save (then derived from `entries`). */
  readonly credits?: number
  /** Ticks accumulated toward the next upkeep drain. Absent in pre-upkeep saves → 0. */
  readonly upkeepTimer?: number
  /**
   * LEGACY per-colour bank (pre-G6): distinct colours + banked amounts. Present only in an old save
   * that predates the credit economy; ignored once `credits` is present.
   */
  readonly entries?: readonly { readonly color: number; readonly amount: number }[]
}

/** Capture the treasury as a plain snapshot (credit balance + upkeep timer → byte-identical round-trip). */
export function serializeTreasury(t: TreasuryStore): TreasurySnapshot {
  return { credits: t.credits, upkeepTimer: t.upkeepTimer }
}

/**
 * Load a treasury snapshot into an existing store in place (systems close over the store). A current
 * save carries `credits` directly. A LEGACY per-colour save (pre-G6, only `entries`) is migrated by
 * SELLING every banked unit at its current price — `credits = Σ amount × price(colour)` — the same
 * rule a depot deposit uses, so an old bank converts to exactly what those goods are now worth. The
 * price table must already be loaded (the host supplies it before restoring a save).
 */
export function loadTreasurySnapshot(
  t: TreasuryStore,
  prices: PriceTable,
  snap: TreasurySnapshot,
): void {
  t.upkeepTimer = Math.max(0, Math.floor(snap.upkeepTimer ?? 0))
  if (snap.credits !== undefined) {
    t.credits = Math.max(0, Math.floor(snap.credits))
    return
  }
  let credits = 0
  for (const e of snap.entries ?? []) credits += Math.max(0, e.amount) * priceOf(prices, e.color)
  t.credits = credits
}

/**
 * Plain, JSON-safe capture of the whole base-game {@link GameState} — everything the sim keeps
 * outside the ECS (belt grid, building stockpiles, terrain types, villages, research, the treasury
 * bank and the new-game config). This is what the base game contributes to a save's per-mod state
 * blob so nothing sim-critical is dropped. Terrain is emitted sorted by packed key so the capture
 * is canonical (Map order is insertion-dependent); belts/buildings/villages keep dense-index order
 * (rebuilt in the same order, so a round-trip re-serializes byte-identically).
 */
export interface GameStateSnapshot {
  readonly belt: BeltSnapshot
  readonly buildings: readonly BuildingSnapshot[]
  readonly terrain: readonly (readonly [number, number])[]
  /**
   * Finite deposit richness as `[tileKey, remaining]` pairs, sorted by key (canonical, like
   * `terrain`). Absent in pre-richness saves → every deposit loads as infinite (legacy behaviour).
   * The terrain-entity links ({@link DepositStore.eid}) are rebuilt from the re-spawned entities,
   * not stored.
   */
  readonly deposits?: readonly (readonly [number, number])[]
  readonly villages: VillageSnapshot
  readonly research: ResearchSnapshot
  /** The credit balance + upkeep timer. Absent in pre-treasury saves → loads as empty (0 credits). */
  readonly treasury?: TreasurySnapshot
  /** New-game rule settings. Absent in pre-treasury saves → loads as defaults. */
  readonly config?: GameConfig
}

/** Capture the base game's {@link GameState} as a plain snapshot (see {@link loadGameState}). */
export function serializeGameState(state: GameState): GameStateSnapshot {
  const g = state.grid
  const tiles: BeltTileSnapshot[] = []
  for (let t = 0; t < g.count; t++) {
    const filterColor: number[] = []
    for (let j = 0; j < MAX_PORT_FILTER; j++)
      filterColor.push(g.filterColor[t * MAX_PORT_FILTER + j]!)
    tiles.push({
      tx: g.tx[t]!,
      ty: g.ty[t]!,
      face: g.face[t]!,
      kind: g.kind[t]!,
      inDir: g.inDir[t]!,
      portTimer: g.portTimer[t]!,
      portEvery: g.portEvery[t]!,
      rr: g.rr[t]!,
      period: g.period[t]!,
      partner: g.partner[t]!,
      filterMode: g.filterMode[t]!,
      filterColor,
    })
  }

  const store = state.buildings
  const buildings: BuildingSnapshot[] = []
  for (let b = 0; b < store.count; b++) {
    const slotN = store.slotN[b]!
    const slots: SlotSnapshot[] = []
    for (let k = 0; k < slotN; k++) {
      const i = b * MAX_SLOTS + k
      slots.push({
        color: store.slotColor[i]!,
        count: store.slotCount[i]!,
        cap: store.slotCap[i]!,
        role: store.slotRole[i]!,
        amt: store.slotAmt[i]!,
      })
    }
    buildings.push({
      bx: store.bx[b]!,
      by: store.by[b]!,
      bw: store.bw[b]!,
      bh: store.bh[b]!,
      crafts: store.crafts[b]!,
      depot: store.depot[b]!,
      silo: store.silo[b]!,
      recipe: store.recipe[b]!,
      anchorKey: store.anchorKey[b]!,
      upkeep: store.upkeep[b]!,
      craftEvery: store.craftEvery[b]!,
      craftTimer: store.craftTimer[b]!,
      slots,
    })
  }

  // Sort terrain by packed key: a Map iterates in insertion order, which differs between the
  // scene's insert order and a rebuilt store's, so sorting gives one canonical form.
  const terrain: [number, number][] = [...state.terrain.entries()].sort((a, b) => a[0] - b[0])
  // Deposit richness, same canonical key-sorted form (the `eid` links are re-derived on load).
  const deposits: [number, number][] = [...state.deposits.remaining.entries()].sort(
    (a, b) => a[0] - b[0],
  )

  const v = state.villages
  const entries: VillageEntrySnapshot[] = []
  for (let i = 0; i < v.count; i++) {
    const demandAcc: number[] = []
    for (let d = 0; d < MAX_VILLAGE_DEMANDS; d++)
      demandAcc.push(v.demandAcc[i * MAX_VILLAGE_DEMANDS + d]!)
    entries.push({
      vx: v.vx[i]!,
      vy: v.vy[i]!,
      stage: v.stage[i]!,
      growthTimer: v.growthTimer[i]!,
      declineTimer: v.declineTimer[i]!,
      graceTimer: v.graceTimer[i]!,
      demandAcc,
      // Each village carries its own ladder, so the snapshot stores it per entry (distinct
      // settlements have distinct ladders — no single shared one to reference).
      stages: v.ladders[i]!,
    })
  }

  return {
    belt: { tiles, moveTimer: g.moveTimer, moveCount: g.moveCount },
    buildings,
    terrain,
    deposits,
    villages: { timer: v.timer, entries },
    research: serializeResearch(state.research),
    treasury: serializeTreasury(state.treasury),
    // Emit `goal` only when the scenario set one, so a goal-less save's config stays byte-identical
    // to before (and the key order is fixed, keeping the canonical-JSON hash stable across runs).
    config: {
      buildRefundPermille: state.config.buildRefundPermille,
      ...(state.config.goal !== undefined ? { goal: state.config.goal } : {}),
    },
  }
}

/**
 * Reconstruct the base game's {@link GameState} from a save. Mutates `state`'s stores IN PLACE
 * (the per-tick systems close over these exact store references, so they must not be replaced),
 * and re-spawns every renderable from `entities` through {@link ModApi.spawn} — learning each
 * fresh entity id at creation, then linking the belt/building stores to them by tile and
 * sprite-class. Scenery (terrain fills, orchard trees) is re-spawned and simply left unlinked.
 *
 * Assumes a fresh, scene-less `state` (the base mod's load seam runs this INSTEAD of spawning
 * the starting scene — see main.ts), so there are no prior entities to reconcile.
 */
export function loadGameState(
  api: ModApi,
  state: GameState,
  entities: readonly EntityData[],
  snap: GameStateSnapshot,
): void {
  // Re-spawn everything, indexing the store-owned entities by tile. A belt tile carries at most
  // one track arrow, one overlay and one item; a building footprint is unique by its top-left.
  const trackByTile = new Map<number, number>()
  const markByTile = new Map<number, number>()
  const itemByTile = new Map<number, number>()
  const footprintByTopLeft = new Map<number, number>()
  const terrainByTile = new Map<number, number>() // deposit terrain entities, re-linked to richness
  for (let i = 0; i < entities.length; i++) {
    const e = entities[i]!
    const eid = api.spawn({
      pos: { x: e.x, y: e.y },
      sprite: e.sprite,
      color: e.color,
      width: e.width,
      height: e.height,
    })
    const key = tileKey(e.x, e.y)
    const shape = e.sprite >> 2 // sprite = shape * 4 + orient
    if (shape === SHAPE_BELT_ARROW) trackByTile.set(key, eid)
    else if (
      shape === SHAPE_PORT_ARROW ||
      shape === SHAPE_SPLITTER ||
      shape === SHAPE_UNDER_IN ||
      shape === SHAPE_UNDER_OUT
    )
      markByTile.set(key, eid)
    else if (shape === SHAPE_CIRCLE) itemByTile.set(key, eid)
    else if (shape === SHAPE_TERRAIN) terrainByTile.set(key, eid)
    else footprintByTopLeft.set(key, eid) // building footprint
  }

  // Belt grid: replay the tiles, then link each tile's entities from the index.
  const g = state.grid
  const bs = snap.belt
  ensureCapacity(g, Math.max(1, bs.tiles.length))
  g.index.clear()
  g.count = bs.tiles.length
  for (let t = 0; t < bs.tiles.length; t++) {
    const tile = bs.tiles[t]!
    g.tx[t] = tile.tx
    g.ty[t] = tile.ty
    g.face[t] = tile.face
    g.kind[t] = tile.kind
    g.inDir[t] = tile.inDir
    g.portTimer[t] = tile.portTimer
    g.portEvery[t] = tile.portEvery
    g.rr[t] = tile.rr
    g.period[t] = tile.period
    g.partner[t] = tile.partner ?? NONE
    g.filterMode[t] = tile.filterMode ?? FILTER_NONE
    const fc = tile.filterColor
    for (let j = 0; j < MAX_PORT_FILTER; j++) {
      g.filterColor[t * MAX_PORT_FILTER + j] = fc && j < fc.length ? fc[j]! : FILTER_EMPTY
    }
    const key = tileKey(tile.tx, tile.ty)
    g.trackEid[t] = trackByTile.get(key) ?? NONE
    g.markEid[t] = markByTile.get(key) ?? NONE
    g.slot[t] = itemByTile.get(key) ?? NONE
    g.portBuilding[t] = NONE // relinked below, once buildings are rebuilt.
    g.index.set(key, t)
  }

  // Building store: replay each building and its stockpile slots, linking the footprint entity.
  const store = state.buildings
  ensureBuildingCapacity(store, Math.max(1, snap.buildings.length))
  store.tileIndex.clear()
  store.count = snap.buildings.length
  for (let b = 0; b < snap.buildings.length; b++) {
    const bldg = snap.buildings[b]!
    store.eid[b] = footprintByTopLeft.get(tileKey(bldg.bx, bldg.by)) ?? NONE
    store.bx[b] = bldg.bx
    store.by[b] = bldg.by
    store.bw[b] = bldg.bw
    store.bh[b] = bldg.bh
    store.crafts[b] = bldg.crafts
    store.depot[b] = bldg.depot ?? 0
    store.silo[b] = bldg.silo ?? 0
    store.recipe[b] = bldg.recipe ?? 0
    store.anchorKey[b] = bldg.anchorKey ?? NONE
    store.upkeep[b] = bldg.upkeep ?? 0
    store.craftEvery[b] = bldg.craftEvery
    store.craftTimer[b] = bldg.craftTimer
    store.slotN[b] = bldg.slots.length
    for (let k = 0; k < bldg.slots.length; k++) {
      const slot = bldg.slots[k]!
      const i = b * MAX_SLOTS + k
      store.slotColor[i] = slot.color
      store.slotCount[i] = slot.count
      store.slotCap[i] = slot.cap
      store.slotRole[i] = slot.role
      store.slotAmt[i] = slot.amt
    }
    for (let dy = 0; dy < bldg.bh; dy++) {
      for (let dx = 0; dx < bldg.bw; dx++) {
        store.tileIndex.set(tileKey(bldg.bx + dx, bldg.by + dy), b)
      }
    }
  }

  // Ports link to the buildings they border; then rebuild topology + cadence. recomputeCadence
  // resets the move counters when the base period changes, so restore them AFTERWARDS.
  relinkUnlinkedPorts(g, store)
  rebuildTopology(g)
  recomputeCadence(g)
  g.topoDirty = 0
  g.moveTimer = bs.moveTimer
  g.moveCount = bs.moveCount

  // Terrain layer (already canonical-sorted in the snapshot).
  state.terrain.clear()
  for (let i = 0; i < snap.terrain.length; i++) {
    state.terrain.set(snap.terrain[i]![0], snap.terrain[i]![1])
  }

  // Deposit richness: restore each finite tile's remaining units and re-link it to its re-spawned
  // terrain entity (so a later exhaustion can still grey it). Absent in a pre-richness save → every
  // deposit stays infinite (the Maps stay empty). Exhausted tiles kept their greyed colour in the
  // saved entity, so no recolour is needed on load.
  const dep = state.deposits
  dep.remaining.clear()
  dep.eid.clear()
  const depSnap = snap.deposits ?? []
  for (let i = 0; i < depSnap.length; i++) {
    const key = depSnap[i]![0]
    dep.remaining.set(key, depSnap[i]![1])
    const teid = terrainByTile.get(key)
    if (teid !== undefined) dep.eid.set(key, teid)
  }

  // Villages: reset the store, then replay each village with its own stage ladder (deep-copied so the
  // store never aliases the snapshot). A pre-multi-village save carried one shared ladder on the
  // snapshot instead of per-entry, so fall back to it when an entry has none — old saves still load.
  const v = state.villages
  v.count = 0
  v.ladders.length = 0
  const legacyShared = snap.villages.stages
  const copyLadder = (stages: readonly VillageStageConfig[]): VillageStageConfig[] =>
    stages.map((s) => ({
      population: s.population,
      demands: s.demands.map((d) => ({ color: d.color, ratePerMin: d.ratePerMin })),
    }))
  for (let i = 0; i < snap.villages.entries.length; i++) {
    const entry = snap.villages.entries[i]!
    const ladder = copyLadder(entry.stages ?? legacyShared ?? [])
    const idx = registerVillage(v, entry.vx, entry.vy, ladder)
    v.stage[idx] = entry.stage
    v.growthTimer[idx] = entry.growthTimer
    v.declineTimer[idx] = entry.declineTimer
    // Pre-grace saves omit graceTimer → 0 (no grace), correct for an already-running world.
    v.graceTimer[idx] = entry.graceTimer ?? 0
    const acc = entry.demandAcc ?? []
    for (let d = 0; d < MAX_VILLAGE_DEMANDS; d++) {
      v.demandAcc[idx * MAX_VILLAGE_DEMANDS + d] = acc[d] ?? 0
    }
  }
  v.timer = snap.villages.timer

  // Research: mutate the existing store in place (systems close over it).
  loadResearchSnapshot(state.research, snap.research)

  // Treasury + config: mutate in place too. Both are optional so a pre-treasury save loads as an
  // empty balance with default rules. A legacy per-colour bank is converted to credits via the
  // price table (already supplied by the host before the load — see loadTreasurySnapshot).
  loadTreasurySnapshot(state.treasury, state.prices, snap.treasury ?? {})
  state.config.buildRefundPermille =
    snap.config?.buildRefundPermille ?? createGameConfig().buildRefundPermille
  // Restore the win goal exactly as saved (absent → cleared), so loading an already-won world knows
  // it, and re-serializing reproduces the same config.
  if (snap.config?.goal !== undefined) state.config.goal = snap.config.goal
  else delete state.config.goal
}

/**
 * Fraction in [0, 1) of the current move-cycle elapsed — the render interpolation factor
 * for belt items. Items step a whole tile once every `moveEvery` ticks; pairing this with
 * the item's source tile in `Position.prev*` lets the renderer glide it smoothly across
 * that tile instead of teleporting on the move tick. `subTickAlpha` (the scheduler's
 * leftover accumulator) keeps it smooth even when the render rate outruns the sim rate.
 */
export function beltMoveAlpha(state: GameState, subTickAlpha = 0): number {
  const g = state.grid
  if (g.moveEvery <= 1) return subTickAlpha
  return (g.moveTimer + subTickAlpha) / g.moveEvery
}

// --- Commands ---------------------------------------------------------------

/**
 * Place a rectangular building with its top-left at (x, y). If `accepts` is given, the
 * building is registered as a resource store accepting those resources (each capped).
 */
export interface PlaceBuildingCommand {
  readonly type: 'place_building'
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly color: number
  /** Resources this building stockpiles (from input ports); omitted/empty for plain scenery. */
  readonly accepts?: readonly AcceptSlot[]
  /**
   * Register this store as a research *lab* (its pack buffer is drained by {@link updateResearch}).
   * Only meaningful when `accepts` gives it a stockpile; omitted/false for a plain store.
   */
  readonly researchLab?: boolean
  /**
   * Register this building as a *depot* (a treasury sink): items belted into it are banked in the
   * global {@link TreasuryStore} rather than stocked. Needs no `accepts`. Omitted/false otherwise.
   */
  readonly depot?: boolean
  /**
   * Register this store as a cannon *silo* (the only building a cargo cannon may target). Needs an
   * `accepts` slot for the payload resource. Omitted/false for a plain store.
   */
  readonly silo?: boolean
  /** Build cost charged from the treasury; the placement is dropped if unaffordable. Omitted = free. */
  readonly cost?: readonly CostEntry[]
  /** Per-cadence upkeep in credits (see {@link UPKEEP_CADENCE}). Omitted = 0 (free to run). */
  readonly upkeep?: number
}

/** Place a conveyor running from tile A to tile B. */
export interface PlaceBeltCommand {
  readonly type: 'place_belt'
  readonly ax: number
  readonly ay: number
  readonly bx: number
  readonly by: number
  readonly color: number
  readonly moveEvery: number
  /**
   * Facing 0..3 (N,E,S,W) to force on every tile of the run, overriding the direction projected
   * from A→B. Omitted for a normal drawn belt (facing follows the drag); set by the blueprint
   * paste path, which lays each captured tile as its own length-1 run and must preserve its exact
   * facing (a length-1 run has no drawn direction to project, so it would otherwise default East).
   */
  readonly face?: number
  /**
   * Total build cost for the whole run (the host multiplies the per-tile belt cost by the run
   * length). Charged all-or-nothing from the treasury; the run is dropped if unaffordable. Free
   * when omitted.
   */
  readonly cost?: readonly CostEntry[]
}

/**
 * Place an input or output port on the belt tile at (x, y). The port links to an
 * orthogonally adjacent building: an output drains it every `spawnEvery` ticks; an input
 * deposits arriving items into it when accepted. A port off any belt is dropped.
 */
export interface PlacePortCommand {
  readonly type: 'place_port'
  readonly x: number
  readonly y: number
  readonly port: 'output' | 'input'
  /** Color of the port's building footprint. */
  readonly color: number
  /** Output ports only: drain the linked building every N ticks. */
  readonly spawnEvery?: number
  /**
   * Facing 0..3 (N,E,S,W) for the port's arrow, set by the player's rotation. An output's
   * arrow points *away* from the building it drains (building opposite the facing); an input's
   * arrow points *into* the building it feeds (building in the facing direction). Omitted: keep
   * the underlying belt tile's facing — back-compat for callers that pre-date rotation.
   */
  readonly dir?: number
  /** Build cost charged from the treasury; the port is dropped if unaffordable. Omitted = free. */
  readonly cost?: readonly CostEntry[]
}

/** Mark the belt tile at (x, y) a splitter. A splitter off any belt is dropped. */
export interface PlaceSplitterCommand {
  readonly type: 'place_splitter'
  readonly x: number
  readonly y: number
  /** Color of the splitter's footprint. */
  readonly color: number
  /** Build cost charged from the treasury; the splitter is dropped if unaffordable. Omitted = free. */
  readonly cost?: readonly CostEntry[]
}

/**
 * Place an underground belt: a pair of caps carrying items under the gap between them. The
 * *entrance* sits at (x, y); the *exit* at (ex, ey), which must lie `1..`{@link UNDERGROUND_MAX_SPAN}
 * tiles ahead of the entrance along `dir` (both endpoints share one axis — the facing). Each cap is
 * laid as a belt tile facing `dir`; the tiles between them are untouched and stay buildable, so a
 * crossing belt in the gap works normally and never interacts with the tunnel. Rejected (nothing
 * placed, nothing charged) unless the axis/span is valid and both endpoints are clear of buildings
 * and of any non-plain belt tile (a plain belt already there is converted into the cap).
 */
export interface PlaceUndergroundCommand {
  readonly type: 'place_underground'
  /** Entrance tile. */
  readonly x: number
  readonly y: number
  /** Exit tile — must be `1..UNDERGROUND_MAX_SPAN` tiles from the entrance along `dir`. */
  readonly ex: number
  readonly ey: number
  /** Facing 0..3 (N,E,S,W): the direction from entrance to exit, and the way both caps carry items. */
  readonly dir: number
  /** Colour of the caps' belt tiles. */
  readonly color: number
  /** Per-tile move period in ticks (the belt tier's `moveEvery`); both caps share it. */
  readonly moveEvery: number
  /** Build cost charged once for the whole pair; the tunnel is dropped if unaffordable. Omitted = free. */
  readonly cost?: readonly CostEntry[]
}

/** One resource flow of a crafter recipe: a resource colour and its per-craft amount. */
export interface CraftFlow {
  readonly color: number
  readonly amount: number
}

/**
 * Place a crafter (farm/woodcutter/mine/furnace/assembler) as a building with its top-left at
 * (x, y). It runs a recipe: every `craftEvery` ticks, when each `input` slot holds enough and
 * each `output` slot has room, it consumes the inputs and produces the outputs into its own
 * stockpile (each slot capped at `storageCap`). Input slots are filled by adjacent input ports;
 * output slots are drained by adjacent output ports. An *extraction* recipe has no inputs (a
 * farm/mine). If `requiresTerrainType` is set (non-zero), the placement is dropped unless the
 * terrain layer at (x, y) matches it — that is how terrain enables/disables a crafter.
 */
export interface PlaceCrafterCommand {
  readonly type: 'place_crafter'
  readonly x: number
  readonly y: number
  /** Footprint size. */
  readonly w: number
  readonly h: number
  /** Color of the crafter building's footprint. */
  readonly color: number
  /**
   * Recipe inputs (resource colour + amount consumed per craft); empty for extraction, and omitted
   * entirely for an empty machine placed with no recipe yet (the player sets it via `set_recipe`).
   */
  readonly inputs?: readonly CraftFlow[]
  /** Recipe outputs (resource colour + amount produced per craft); omitted for an empty machine. */
  readonly outputs?: readonly CraftFlow[]
  /** The recipe's opaque integer id ({@link recipeTypeOf}); omitted/0 for an empty machine. */
  readonly recipe?: number
  /** Attempt one craft every N ticks (recipe `time` / building `speed`). */
  readonly craftEvery: number
  /** Maximum units each stockpile slot can hold. */
  readonly storageCap: number
  /**
   * Terrain type (see {@link terrainTypeOf}) this crafter needs under it, or
   * {@link TERRAIN_NONE}/omitted for a crafter that may sit anywhere.
   */
  readonly requiresTerrainType?: number
  /**
   * Build cost charged from the treasury; the crafter is dropped if unaffordable. Checked *after*
   * the terrain gate, so a placement blocked by terrain is never charged. Omitted = free.
   */
  readonly cost?: readonly CostEntry[]
  /** Per-cadence upkeep in credits (see {@link UPKEEP_CADENCE}). Omitted = 0 (free to run). */
  readonly upkeep?: number
}

/**
 * Set (or change) the recipe of the crafter whose footprint covers (x, y). Rebuilds the crafter's
 * stockpile slots from the recipe's `inputs`/`outputs`, resets its progress, and records the
 * recipe id — the Factorio-style "one machine, pick its recipe" flow. Ignored if no crafter sits
 * there. `recipe === 0` with empty flows clears it back to an idle empty machine.
 */
export interface SetRecipeCommand {
  readonly type: 'set_recipe'
  readonly x: number
  readonly y: number
  /** The recipe's opaque integer id ({@link recipeTypeOf}); 0 clears the machine.  */
  readonly recipe: number
  readonly inputs: readonly CraftFlow[]
  readonly outputs: readonly CraftFlow[]
  /** Attempt one craft every N ticks (recipe `time` / building `speed`). */
  readonly craftEvery: number
  /** Maximum units each stockpile slot can hold. */
  readonly storageCap: number
}

/**
 * Remove whatever the player can delete at tile (x, y): a belt-grid tile (belt, port or
 * splitter) or a resource-holding building (crafter or store). Passive terrain and plain
 * scenery (e.g. the orchard) are NOT removable — they live in neither store, so a remove on
 * such a tile is a no-op. The handler despawns the object's entities, compacts the affected
 * store, and re-links any ports that pointed at a removed building.
 */
export interface RemoveCommand {
  readonly type: 'remove'
  readonly x: number
  readonly y: number
  /**
   * The removed object's build cost, so the treasury can be credited its (config-scaled) refund —
   * the host supplies it from whatever prototype sits at (x, y). Only applied when something is
   * actually removed; omitted (or on a no-op remove) means no refund.
   */
  readonly refund?: readonly CostEntry[]
}

/**
 * Select the technology research works toward. Single-active: the {@link updateResearch} system
 * drains packs into this tech until its `cost` is met, then goes idle until the next selection.
 * `tech` is the opaque integer id ({@link techTypeOf}) and `cost` its authored per-pack
 * requirement — a list of `{ color, amount }` pairs (one per science pack the tech needs), all
 * supplied by the host, which owns the tech string↔int and item→colour mappings. A tech already
 * completed is ignored.
 */
export interface SetActiveResearchCommand {
  readonly type: 'set_active_research'
  readonly tech: number
  readonly cost: readonly { readonly color: number; readonly amount: number }[]
}

/**
 * Set (or clear) the colour filter on the port at tile (x, y). `mode` is FILTER_NONE (clear),
 * FILTER_WHITELIST or FILTER_BLACKLIST; `colors` lists the filtered colours (up to
 * {@link MAX_PORT_FILTER}; extras are ignored). A no-op if the tile is not an input/output port.
 * An output port then drains only slots the filter admits, an input port ingests only such items —
 * so a multi-output machine's products can be split onto separate belts, or a mixed line sorted.
 */
export interface SetPortFilterCommand {
  readonly type: 'set_port_filter'
  readonly x: number
  readonly y: number
  readonly mode: number
  readonly colors: readonly number[]
}

/**
 * Place a cargo cannon (long-haul artillery) as a building with its top-left at (x, y). It is fed
 * like any building: adjacent input ports fill its single deposit buffer with `itemColor`. Once the
 * buffer holds a full `payload` and it has a linked silo (see {@link SetCannonTargetCommand}), it
 * fires a shell every {@link CANNON_FIRE_EVERY} ticks that flies to the silo and unloads there.
 * Cannons are meant to be expensive — pass a stiff `cost`.
 */
export interface PlaceCannonCommand {
  readonly type: 'place_cannon'
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  /** Colour of the cannon building's footprint. */
  readonly color: number
  /** The resource colour the cannon accepts + flings. */
  readonly itemColor: number
  /** Units flung per shot (also the deposit buffer's per-shot size). */
  readonly payload: number
  /** Build cost charged from the treasury; the cannon is dropped if unaffordable. Omitted = free. */
  readonly cost?: readonly CostEntry[]
}

/**
 * Link the cargo cannon whose footprint covers (x, y) to a receiving silo at (tx, ty). The cannon
 * holds fire until linked; re-issuing re-aims it. A no-op if there is no cannon at (x, y).
 */
export interface SetCannonTargetCommand {
  readonly type: 'set_cannon_target'
  readonly x: number
  readonly y: number
  /** Silo tile to fire at, or {@link NONE} on both axes to clear the link. Non-silo tiles are ignored. */
  readonly tx: number
  readonly ty: number
}

/** Toggle auto-firing for the cargo cannon whose footprint covers (x, y). A no-op if none there. */
export interface SetCannonEnabledCommand {
  readonly type: 'set_cannon_enabled'
  readonly x: number
  readonly y: number
  readonly enabled: boolean
}

export type GameCommand =
  | PlaceBuildingCommand
  | PlaceBeltCommand
  | PlacePortCommand
  | PlaceSplitterCommand
  | PlaceUndergroundCommand
  | PlaceCrafterCommand
  | PlaceCannonCommand
  | SetRecipeCommand
  | SetActiveResearchCommand
  | SetPortFilterCommand
  | SetCannonTargetCommand
  | SetCannonEnabledCommand
  | RemoveCommand

/** Copy every per-tile field of the belt grid from index `src` to `dst` (swap-remove move). */
function copyTile(g: BeltGrid, src: number, dst: number): void {
  g.tx[dst] = g.tx[src]!
  g.ty[dst] = g.ty[src]!
  g.face[dst] = g.face[src]!
  g.kind[dst] = g.kind[src]!
  g.slot[dst] = g.slot[src]!
  g.inDir[dst] = g.inDir[src]!
  g.portTimer[dst] = g.portTimer[src]!
  g.portEvery[dst] = g.portEvery[src]!
  g.portBuilding[dst] = g.portBuilding[src]!
  g.filterMode[dst] = g.filterMode[src]!
  for (let j = 0; j < MAX_PORT_FILTER; j++) {
    g.filterColor[dst * MAX_PORT_FILTER + j] = g.filterColor[src * MAX_PORT_FILTER + j]!
  }
  g.rr[dst] = g.rr[src]!
  g.trackEid[dst] = g.trackEid[src]!
  g.markEid[dst] = g.markEid[src]!
  g.period[dst] = g.period[src]!
  g.dueEvery[dst] = g.dueEvery[src]!
  g.partner[dst] = g.partner[src]!
  // nbr/order are rebuilt by the caller, so they need not be copied here.
}

/**
 * Remove belt-grid tile `t`: despawn its riding item, its track entity and any port/splitter
 * overlay, drop it from the index, then swap the last tile into its slot (dense compaction) and
 * rebuild topology + cadence. Off the hot path (player deletion only).
 */
function removeBeltTile(api: ModApi, g: BeltGrid, t: number): void {
  if (g.slot[t] !== NONE) api.despawn(g.slot[t]!)
  if (g.trackEid[t] !== NONE) api.despawn(g.trackEid[t]!)
  if (g.markEid[t] !== NONE) api.despawn(g.markEid[t]!)
  g.index.delete(tileKey(g.tx[t]!, g.ty[t]!))
  const last = g.count - 1
  if (t !== last) {
    copyTile(g, last, t)
    g.index.set(tileKey(g.tx[t]!, g.ty[t]!), t)
  }
  g.count--
  // Swap-remove moved the tile at `last` into slot `t`; repoint any underground partner that pointed
  // at `last` to its new index so tunnel pairings survive compaction (mirrors the port repoint in
  // removeBuilding). A partner that pointed at the removed tile `t` is left stale — the caller (the
  // remove handler) removes the partner cap in the same gesture, so it never survives to be used.
  if (t !== last) {
    for (let s = 0; s < g.count; s++) if (g.partner[s] === last) g.partner[s] = t
  }
  rebuildTopology(g)
  recomputeCadence(g)
  // This rebuild already reflects the whole grid, so no batch flush is owed.
  g.topoDirty = 0
}

/** Copy every per-building field (including stockpile slots) from `src` to `dst`. */
function copyBuilding(s: BuildingStore, src: number, dst: number): void {
  s.eid[dst] = s.eid[src]!
  s.bx[dst] = s.bx[src]!
  s.by[dst] = s.by[src]!
  s.bw[dst] = s.bw[src]!
  s.bh[dst] = s.bh[src]!
  s.crafts[dst] = s.crafts[src]!
  s.depot[dst] = s.depot[src]!
  s.silo[dst] = s.silo[src]!
  s.recipe[dst] = s.recipe[src]!
  s.craftEvery[dst] = s.craftEvery[src]!
  s.craftTimer[dst] = s.craftTimer[src]!
  s.anchorKey[dst] = s.anchorKey[src]!
  s.upkeep[dst] = s.upkeep[src]!
  s.slotN[dst] = s.slotN[src]!
  for (let k = 0; k < MAX_SLOTS; k++) {
    s.slotColor[dst * MAX_SLOTS + k] = s.slotColor[src * MAX_SLOTS + k]!
    s.slotCount[dst * MAX_SLOTS + k] = s.slotCount[src * MAX_SLOTS + k]!
    s.slotCap[dst * MAX_SLOTS + k] = s.slotCap[src * MAX_SLOTS + k]!
    s.slotRole[dst * MAX_SLOTS + k] = s.slotRole[src * MAX_SLOTS + k]!
    s.slotAmt[dst * MAX_SLOTS + k] = s.slotAmt[src * MAX_SLOTS + k]!
  }
}

/**
 * Remove building `b`: despawn its footprint entity, clear its footprint tiles from the index,
 * then swap the last building into its slot. Any port that drained/fed the removed building is
 * unlinked (set to NONE); any port that pointed at the moved building is repointed to its new
 * dense id. Off the hot path (player deletion only).
 */
function removeBuilding(api: ModApi, store: BuildingStore, g: BeltGrid, b: number): void {
  api.despawn(store.eid[b]!)
  for (let dy = 0; dy < store.bh[b]!; dy++) {
    for (let dx = 0; dx < store.bw[b]!; dx++) {
      store.tileIndex.delete(tileKey(store.bx[b]! + dx, store.by[b]! + dy))
    }
  }
  // Ports bound to the removed building now link to nothing.
  for (let t = 0; t < g.count; t++) {
    if ((g.kind[t] === KIND_OUTPUT || g.kind[t] === KIND_INPUT) && g.portBuilding[t] === b) {
      g.portBuilding[t] = NONE
    }
  }
  const last = store.count - 1
  if (b !== last) {
    copyBuilding(store, last, b)
    // Re-index the moved building's footprint tiles, and follow its ports to the new id.
    for (let dy = 0; dy < store.bh[b]!; dy++) {
      for (let dx = 0; dx < store.bw[b]!; dx++) {
        store.tileIndex.set(tileKey(store.bx[b]! + dx, store.by[b]! + dy), b)
      }
    }
    for (let t = 0; t < g.count; t++) {
      if ((g.kind[t] === KIND_OUTPUT || g.kind[t] === KIND_INPUT) && g.portBuilding[t] === last) {
        g.portBuilding[t] = b
      }
    }
  }
  store.count--
}

/**
 * Charge `cost` from the treasury for a placement. Returns false — telling the caller to drop the
 * placement — when the pool cannot cover it; otherwise spends and returns true. A free placement
 * (no/empty cost) always proceeds. Must be called only *after* any non-cost drop check (terrain,
 * off-belt) so a placement rejected for another reason is never charged.
 */
function charge(state: GameState, cost: readonly CostEntry[] | undefined): boolean {
  if (cost === undefined || cost.length === 0) return true
  if (!canAffordTreasury(state.treasury, state.prices, cost)) return false
  spendTreasury(state.treasury, state.prices, cost)
  return true
}

/**
 * Whether the w×h footprint anchored at (x, y) is free for a building/crafter: every tile must be
 * empty of belt-grid tiles (belts/ports/splitters), of any registered building, and of build-blocking
 * terrain (water). Mirrored by the app-side placement ghost so its red "blocked" preview agrees with
 * what the sim would reject. Off the hot path (one player placement).
 */
function footprintClear(state: GameState, x: number, y: number, w: number, h: number): boolean {
  const g = state.grid
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      if (tileAt(g, x + dx, y + dy) !== NONE) return false
      if (buildingAt(state.buildings, x + dx, y + dy) !== NONE) return false
      if (terrainBlocksBuild(state, x + dx, y + dy)) return false
    }
  }
  return true
}

/**
 * Demote underground cap `p` back to a plain belt: drop its ramp overlay and clear its kind/partner.
 * Used when its paired cap is removed — the tunnel breaks and the surviving end becomes an ordinary
 * belt tile (its track arrow already shows the belt glyph, so only the overlay is dropped). The caller
 * rebuilds topology afterwards, restoring the tile's forward neighbour to its physical neighbour.
 */
function demoteCapToBelt(api: ModApi, g: BeltGrid, p: number): void {
  g.kind[p] = KIND_PLAIN
  g.partner[p] = NONE
  if (g.markEid[p] !== NONE) {
    api.despawn(g.markEid[p]!)
    g.markEid[p] = NONE
  }
}

/**
 * Whether tile (x, y) may host an underground cap: it must be clear of any building and of any belt
 * tile that is NOT a plain belt (a port/splitter/existing cap). A plain belt already there is allowed
 * — the placement converts it into the cap. Mirrored by the app-side placement ghost so the preview
 * agrees with what the sim accepts. Off the hot path (one player placement).
 */
function undergroundEndpointClear(state: GameState, x: number, y: number): boolean {
  if (buildingAt(state.buildings, x, y) !== NONE) return false
  if (terrainBlocksBuild(state, x, y)) return false // a cap can't surface on water (the tunnel passes under)
  const t = tileAt(state.grid, x, y)
  return t === NONE || state.grid.kind[t] === KIND_PLAIN
}

function applyCommand(gw: GameWorld, api: ModApi, state: GameState, cmd: GameCommand): void {
  const g = state.grid
  switch (cmd.type) {
    case 'place_building': {
      // Reject a footprint overlapping a belt or another building before charging, so a blocked
      // placement is never billed and can't stack two structures on one tile.
      if (!footprintClear(state, cmd.x, cmd.y, cmd.w, cmd.h)) return
      if (!charge(state, cmd.cost)) return
      const accepts = cmd.accepts ?? []
      // A depot (treasury sink), a silo and a plain store all wear the warehouse roof; a research
      // lab the dome. Plain scenery (no accepts, not a depot) stays the capless footprint (shape 0).
      const buildShape = cmd.researchLab
        ? SHAPE_LAB
        : cmd.depot || accepts.length > 0
          ? SHAPE_DEPOT
          : 0
      const eid = api.spawn({
        pos: { x: cmd.x, y: cmd.y },
        sprite: sprite(buildShape, 0),
        color: cmd.color,
        width: cmd.w,
        height: cmd.h,
      })
      // A store, a lab, a depot or a silo is registered in the building store; plain scenery (no
      // accepts, not a depot) just gets a footprint entity. A depot needs no accept slots (it banks
      // to the treasury), so register it even with an empty accept list.
      if (accepts.length > 0 || cmd.depot) {
        registerBuilding(
          state.buildings,
          eid,
          cmd.x,
          cmd.y,
          cmd.w,
          cmd.h,
          0,
          1,
          storeSlots(accepts),
          cmd.depot ? 1 : 0,
          cmd.silo ? 1 : 0,
          cmd.upkeep ?? 0,
        )
        relinkUnlinkedPorts(g, state.buildings)
        // A lab is a store the research system drains its packs from; anchor it by tile.
        if (cmd.researchLab) registerResearchLab(state.research, cmd.x, cmd.y)
      }
      return
    }
    case 'place_belt': {
      const { dx, dy, length } = projectBelt(cmd.ax, cmd.ay, cmd.bx, cmd.by)
      // Nothing builds on water: reject the whole run (before charging) if any tile of it would land
      // on build-blocking terrain. The app previews this red; a tunnel is the way to cross — its
      // buried mid-section never touches the water tile, only its caps must sit on clear ground.
      for (let i = 0; i < length; i++) {
        if (terrainBlocksBuild(state, cmd.ax + dx * i, cmd.ay + dy * i)) return
      }
      if (!charge(state, cmd.cost)) return
      // A forced facing (blueprint paste) wins over the direction projected from the drawn run.
      const face = cmd.face !== undefined ? cmd.face & 3 : dirOf(dx, dy)
      const period = Math.max(1, cmd.moveEvery)
      for (let i = 0; i < length; i++) {
        addOrAimTile(gw, api, g, cmd.ax + dx * i, cmd.ay + dy * i, face, cmd.color, period)
      }
      g.topoDirty = 1
      recomputeCadence(g)
      return
    }
    case 'place_port': {
      const t = tileAt(g, cmd.x, cmd.y)
      if (t === NONE) return // a port must sit on a belt; off-belt placements are dropped.
      if (!charge(state, cmd.cost)) return
      // The arrow facing — and, for an output, the direction drained items leave on — is the
      // placed rotation when the host supplies one; otherwise keep the tile's belt facing.
      if (cmd.dir !== undefined) g.face[t] = cmd.dir & 3
      if (cmd.port === 'output') {
        g.kind[t] = KIND_OUTPUT
        g.portEvery[t] = Math.max(1, cmd.spawnEvery ?? 20)
        g.portTimer[t] = 0
      } else {
        g.kind[t] = KIND_INPUT
      }
      linkPort(g, state.buildings, t)
      g.topoDirty = 1
      // Re-placing a port over an existing one replaces its overlay glyph; drop the old first.
      if (g.markEid[t] !== NONE) api.despawn(g.markEid[t]!)
      g.markEid[t] = api.spawn({
        pos: { x: cmd.x, y: cmd.y },
        sprite: sprite(SHAPE_PORT_ARROW, g.face[t]!),
        color: cmd.color,
        width: 1,
        height: 1,
      })
      return
    }
    case 'place_splitter': {
      const t = tileAt(g, cmd.x, cmd.y)
      if (t === NONE) return // a splitter must sit on a belt; off-belt placements are dropped.
      if (!charge(state, cmd.cost)) return
      g.kind[t] = KIND_SPLITTER
      g.rr[t] = 0
      g.topoDirty = 1
      if (g.markEid[t] !== NONE) api.despawn(g.markEid[t]!)
      g.markEid[t] = api.spawn({
        pos: { x: cmd.x, y: cmd.y },
        sprite: sprite(SHAPE_SPLITTER, g.face[t]!),
        color: cmd.color,
        width: 1,
        height: 1,
      })
      return
    }
    case 'place_underground': {
      const dir = cmd.dir & 3
      // The exit must lie a positive 1..MAX span ahead of the entrance along the facing axis — same
      // axis, correct direction. This rejects off-axis, reversed and over-long spans before charging.
      const span = Math.abs(cmd.ex - cmd.x) + Math.abs(cmd.ey - cmd.y)
      if (span < 1 || span > UNDERGROUND_MAX_SPAN) return
      if (cmd.x + DX[dir]! * span !== cmd.ex || cmd.y + DY[dir]! * span !== cmd.ey) return
      // Both caps must sit on clear ground (or a plain belt, which is converted). Mid-tunnel tiles are
      // never touched, so a crossing belt in the gap keeps working — that is the whole point.
      if (!undergroundEndpointClear(state, cmd.x, cmd.y)) return
      if (!undergroundEndpointClear(state, cmd.ex, cmd.ey)) return
      if (!charge(state, cmd.cost)) return
      const period = Math.max(1, cmd.moveEvery)
      const inT = addOrAimTile(gw, api, g, cmd.x, cmd.y, dir, cmd.color, period)
      const outT = addOrAimTile(gw, api, g, cmd.ex, cmd.ey, dir, cmd.color, period)
      g.kind[inT] = KIND_UNDER_IN
      g.kind[outT] = KIND_UNDER_OUT
      // Pair both ways so removing either cap can find and drop the other (see the remove handler).
      g.partner[inT] = outT
      g.partner[outT] = inT
      // Stamp the ramp glyph on each cap (over the belt-arrow backdrop the track entity draws),
      // mirroring how a port overlays its arrow; drop any overlay left from a converted tile first.
      if (g.markEid[inT] !== NONE) api.despawn(g.markEid[inT]!)
      g.markEid[inT] = api.spawn({
        pos: { x: cmd.x, y: cmd.y },
        sprite: sprite(SHAPE_UNDER_IN, dir),
        color: cmd.color,
        width: 1,
        height: 1,
      })
      if (g.markEid[outT] !== NONE) api.despawn(g.markEid[outT]!)
      g.markEid[outT] = api.spawn({
        pos: { x: cmd.ex, y: cmd.ey },
        sprite: sprite(SHAPE_UNDER_OUT, dir),
        color: cmd.color,
        width: 1,
        height: 1,
      })
      g.topoDirty = 1
      recomputeCadence(g)
      return
    }
    case 'place_crafter': {
      // Terrain gate: an extraction crafter works its footprint expanded by EXTRACTOR_REACH, so it
      // may sit on OR within a tile of a matching deposit — find the deposit it anchors to and drop
      // the placement if none is in reach. An unrestricted crafter carries TERRAIN_NONE (no anchor).
      const need = cmd.requiresTerrainType ?? TERRAIN_NONE
      let anchorKey = NONE
      if (need !== TERRAIN_NONE) {
        anchorKey = extractorAnchorInReach(
          state.terrain,
          cmd.x,
          cmd.y,
          cmd.w,
          cmd.h,
          (tt) => tt === need,
        )
        if (anchorKey === -1) return
      }
      // Same occupancy gate as a building: the crafter's footprint must be clear of belts and
      // other buildings. Checked after the terrain gate but before charging.
      if (!footprintClear(state, cmd.x, cmd.y, cmd.w, cmd.h)) return
      if (!charge(state, cmd.cost)) return
      // Pick the silhouette from the machine's role: one bound to a terrain type is an extractor
      // (mine/derrick/farm), an input-less machine is a raw producer, anything else a crafter.
      const craftShape =
        need !== TERRAIN_NONE
          ? SHAPE_EXTRACTOR
          : (cmd.inputs?.length ?? 0) === 0
            ? SHAPE_PRODUCER
            : SHAPE_CRAFTER
      const eid = api.spawn({
        pos: { x: cmd.x, y: cmd.y },
        sprite: sprite(craftShape, 0),
        color: cmd.color,
        width: cmd.w,
        height: cmd.h,
      })
      // Build the crafter's slots from its recipe: inputs are deposit-only (fed by input
      // ports, consumed each craft), outputs drain-only (produced each craft, pulled by
      // output ports). Slot order is inputs then outputs. A machine placed with no recipe yet
      // (empty inputs+outputs) registers as an idle crafter until `set_recipe` arms it.
      const inputs = cmd.inputs ?? []
      const outputs = cmd.outputs ?? []
      const slots: BuildingSlot[] = []
      for (let i = 0; i < inputs.length; i++) {
        slots.push({
          color: inputs[i]!.color,
          cap: cmd.storageCap,
          role: ROLE_DEPOSIT,
          amt: inputs[i]!.amount,
        })
      }
      for (let i = 0; i < outputs.length; i++) {
        slots.push({
          color: outputs[i]!.color,
          cap: cmd.storageCap,
          role: ROLE_DRAIN,
          amt: outputs[i]!.amount,
        })
      }
      const b = registerBuilding(
        state.buildings,
        eid,
        cmd.x,
        cmd.y,
        cmd.w,
        cmd.h,
        1,
        cmd.craftEvery,
        slots,
        0,
        0,
        cmd.upkeep ?? 0,
      )
      state.buildings.recipe[b] = cmd.recipe ?? 0
      // A terrain-gated crafter is an extractor: cache the covered deposit it anchors to (resolved
      // above) so the depletion hot path reads its resource terrain type — and pools richness across
      // the reach — by a bare key. Left as NONE for machines that need no terrain.
      if (need !== TERRAIN_NONE) state.buildings.anchorKey[b] = anchorKey
      relinkUnlinkedPorts(g, state.buildings)
      return
    }
    case 'place_cannon': {
      if (!charge(state, cmd.cost)) return
      // A cannon is a building with a single deposit buffer (holding a couple of shots' worth) so
      // input ports feed it; the CannonStore record carries its firing state.
      const eid = api.spawn({
        pos: { x: cmd.x, y: cmd.y },
        sprite: sprite(SHAPE_CANNON, 0),
        color: cmd.color,
        width: cmd.w,
        height: cmd.h,
      })
      registerBuilding(state.buildings, eid, cmd.x, cmd.y, cmd.w, cmd.h, 0, 1, [
        {
          color: cmd.itemColor,
          cap: Math.max(1, cmd.payload) * CANNON_BUFFER_SHOTS,
          role: ROLE_DEPOSIT,
          amt: 0,
        },
      ])
      const c = registerCannon(state.cannons, cmd.x, cmd.y, cmd.itemColor, cmd.payload)
      // QoL: if a matching silo already sits within range, link to the nearest one automatically so
      // a freshly-placed cannon just works. The player can always re-aim it later.
      autoLinkCannon(state, c)
      relinkUnlinkedPorts(g, state.buildings)
      return
    }
    case 'set_cannon_target': {
      const c = cannonAt(state.cannons, cmd.x, cmd.y)
      if (c === NONE) return
      // The target must be a defined silo (never a generic store/depot). A non-silo tile is rejected
      // so the cannon keeps its previous target; passing NONE explicitly clears the link.
      if (cmd.tx === NONE) {
        state.cannons.tx[c] = NONE
        state.cannons.ty[c] = NONE
        return
      }
      const b = buildingAt(state.buildings, cmd.tx, cmd.ty)
      if (b === NONE || !state.buildings.silo[b]) return
      state.cannons.tx[c] = cmd.tx
      state.cannons.ty[c] = cmd.ty
      return
    }
    case 'set_cannon_enabled': {
      const c = cannonAt(state.cannons, cmd.x, cmd.y)
      if (c === NONE) return
      state.cannons.enabled[c] = cmd.enabled ? 1 : 0
      return
    }
    case 'set_recipe': {
      const b = buildingAt(state.buildings, cmd.x, cmd.y)
      if (b === NONE || !state.buildings.crafts[b]) return // nothing craftable there
      setBuildingRecipe(
        state.buildings,
        b,
        cmd.recipe,
        cmd.inputs,
        cmd.outputs,
        cmd.craftEvery,
        cmd.storageCap,
      )
      relinkUnlinkedPorts(g, state.buildings)
      return
    }
    case 'set_port_filter': {
      const t = tileAt(g, cmd.x, cmd.y)
      if (t === NONE) return // no belt tile there
      if (g.kind[t] !== KIND_OUTPUT && g.kind[t] !== KIND_INPUT) return // only ports carry a filter
      const mode =
        cmd.mode === FILTER_WHITELIST || cmd.mode === FILTER_BLACKLIST ? cmd.mode : FILTER_NONE
      g.filterMode[t] = mode
      const base = t * MAX_PORT_FILTER
      for (let j = 0; j < MAX_PORT_FILTER; j++) {
        g.filterColor[base + j] = j < cmd.colors.length ? cmd.colors[j]! : FILTER_EMPTY
      }
      return
    }
    case 'set_active_research': {
      // Ignore a re-selection of an already-completed tech; otherwise arm it and reset progress.
      const r = state.research
      if (researchCompleted(r, cmd.tech)) return
      r.activeTech = cmd.tech
      r.costN = Math.min(cmd.cost.length, MAX_RESEARCH_COST)
      for (let c = 0; c < r.costN; c++) {
        r.costColor[c] = cmd.cost[c]!.color
        r.costAmount[c] = Math.max(1, cmd.cost[c]!.amount)
        r.progress[c] = 0
      }
      return
    }
    case 'remove': {
      // Belt-grid tiles take precedence (a port/splitter sits on a belt tile); then resource
      // buildings. Terrain and plain scenery are in neither store, so they are never removed.
      const t = tileAt(g, cmd.x, cmd.y)
      if (t !== NONE) {
        // Removing one underground cap breaks the tunnel: demote its partner back to a plain belt
        // (before the swap-remove shifts indices) so a lone cap never lingers, then remove this cap.
        // removeBeltTile rebuilds topology, restoring the demoted belt's ordinary forward neighbour.
        if (g.kind[t] === KIND_UNDER_IN || g.kind[t] === KIND_UNDER_OUT) {
          const p = g.partner[t]!
          if (p !== NONE) demoteCapToBelt(api, g, p)
        }
        removeBeltTile(api, g, t)
        if (cmd.refund) refundTreasury(state.treasury, state.config, state.prices, cmd.refund)
        return
      }
      const b = buildingAt(state.buildings, cmd.x, cmd.y)
      if (b !== NONE) {
        // A cannon is also a CannonStore record — drop it too (its footprint tile is its key). Any
        // shell already in flight keeps going and lands (or is dropped if its silo is gone).
        const c = cannonAt(state.cannons, cmd.x, cmd.y)
        if (c !== NONE) removeCannon(state.cannons, c)
        removeBuilding(api, state.buildings, g, b)
        if (cmd.refund) refundTreasury(state.treasury, state.config, state.prices, cmd.refund)
      }
      return
    }
  }
}

// --- Cargo cannons ----------------------------------------------------------

/**
 * Cargo cannons: expensive artillery that lob a payload of one resource across the map to a linked
 * receiving silo, letting a factory bridge huge distances no belt could span. A cannon is a normal
 * building (fed by input ports into a single deposit buffer); this store adds only its *firing*
 * state — the linked target tile, the payload colour/size and a cooldown. Shells in flight live in
 * a parallel {@link ShellStore}. Fully deterministic: firing is gated on integer buffer counts and
 * a tick timer, and a shell advances a fixed number of integer tiles per tick along a straight line
 * to the silo (its logical tile is what's hashed; the render just interpolates between ticks).
 */

/** Ticks between shots once a cannon is loaded (a deliberate reload beat, so cannons pulse). */
const CANNON_FIRE_EVERY = 30
/** Tiles a shell advances per tick — fast, so a cannon is a long-haul express, not a slow drift. */
const SHELL_SPEED = 3
/** A cannon's deposit buffer holds this many shots, so it can reload while a shell is still flying. */
const CANNON_BUFFER_SHOTS = 2
/**
 * A cannon's maximum firing range, in tiles (Chebyshev — a square reach). A silo further than this
 * can be linked but the cannon holds fire; auto-linking only ever picks a silo inside this reach.
 * Exported so the UI can draw the range footprint and warn on an out-of-range target.
 */
export const CANNON_RANGE = 40

export interface CannonStore {
  count: number
  /** Cannon building's footprint top-left — how we find its buffer slot + render entity each tick. */
  cx: Int32Array
  cy: Int32Array
  /** Linked silo tile, or {@link NONE} on both axes when unlinked (the cannon holds fire). */
  tx: Int32Array
  ty: Int32Array
  /** Payload resource colour and units flung per shot. */
  color: Int32Array
  payload: Int32Array
  /** Reload cooldown countdown between shots. */
  timer: Int32Array
  /** 1 if auto-firing is on (the default), 0 if the player has paused this cannon. */
  enabled: Int8Array
}

export function createCannonStore(): CannonStore {
  const cap = 4
  return {
    count: 0,
    cx: new Int32Array(cap),
    cy: new Int32Array(cap),
    tx: new Int32Array(cap).fill(NONE),
    ty: new Int32Array(cap).fill(NONE),
    color: new Int32Array(cap),
    payload: new Int32Array(cap).fill(1),
    timer: new Int32Array(cap),
    enabled: new Int8Array(cap).fill(1),
  }
}

function ensureCannonCapacity(s: CannonStore, need: number): void {
  const cap = s.cx.length
  if (need <= cap) return
  let next = cap
  while (next < need) next *= 2
  s.cx = grow(s.cx, next, 0)
  s.cy = grow(s.cy, next, 0)
  s.tx = grow(s.tx, next, NONE)
  s.ty = grow(s.ty, next, NONE)
  s.color = grow(s.color, next, 0)
  s.payload = grow(s.payload, next, 1)
  s.timer = grow(s.timer, next, 0)
  s.enabled = grow8(s.enabled, next, 1)
}

/** Register a cannon at building tile (x, y) carrying `payload` units of `color`. Off the hot path. */
export function registerCannon(
  store: CannonStore,
  x: number,
  y: number,
  color: number,
  payload: number,
): number {
  ensureCannonCapacity(store, store.count + 1)
  const c = store.count++
  store.cx[c] = x
  store.cy[c] = y
  store.tx[c] = NONE
  store.ty[c] = NONE
  store.color[c] = color
  store.payload[c] = Math.max(1, payload)
  store.timer[c] = 0
  store.enabled[c] = 1
  return c
}

/**
 * QoL auto-link: point cannon `c` at the nearest silo that accepts its payload colour and sits
 * within {@link CANNON_RANGE}, if any. A no-op when none qualifies (the cannon stays unlinked and
 * holds fire). Off the hot path (placement only) — a bounded scan over the building store.
 */
function autoLinkCannon(state: GameState, c: number): void {
  const cannons = state.cannons
  const buildings = state.buildings
  const ox = cannons.cx[c]!
  const oy = cannons.cy[c]!
  const color = cannons.color[c]!
  let bestDist = CANNON_RANGE + 1
  let bestX = NONE
  let bestY = NONE
  for (let b = 0; b < buildings.count; b++) {
    if (!buildings.silo[b]) continue
    if (findSlot(buildings, b, color) === NONE) continue // silo doesn't accept this payload
    const bx = buildings.bx[b]!
    const by = buildings.by[b]!
    const dist = Math.max(Math.abs(bx - ox), Math.abs(by - oy))
    if (dist <= CANNON_RANGE && dist < bestDist) {
      bestDist = dist
      bestX = bx
      bestY = by
    }
  }
  if (bestX !== NONE) {
    cannons.tx[c] = bestX
    cannons.ty[c] = bestY
  }
}

/** The cannon id at tile (x, y), or {@link NONE}. Linear scan (cannons are deliberately few). */
function cannonAt(store: CannonStore, x: number, y: number): number {
  for (let c = 0; c < store.count; c++) {
    if (store.cx[c] === x && store.cy[c] === y) return c
  }
  return NONE
}

/** Drop cannon `c` by swap-removing it (order is not sim-significant). Off the hot path. */
function removeCannon(store: CannonStore, c: number): void {
  const last = --store.count
  if (c !== last) {
    store.cx[c] = store.cx[last]!
    store.cy[c] = store.cy[last]!
    store.tx[c] = store.tx[last]!
    store.ty[c] = store.ty[last]!
    store.color[c] = store.color[last]!
    store.payload[c] = store.payload[last]!
    store.timer[c] = store.timer[last]!
    store.enabled[c] = store.enabled[last]!
  }
}

/** Shells in flight: transient projectiles ferrying a cannon's payload to its silo. */
export interface ShellStore {
  count: number
  /** Render entity id (a small item-shaped glyph tinted the payload colour). */
  eid: Int32Array
  /** Current logical tile (hashed). */
  x: Int32Array
  y: Int32Array
  /** Origin (cannon) and destination (silo) tiles the straight flight runs between. */
  ox: Int32Array
  oy: Int32Array
  dx: Int32Array
  dy: Int32Array
  /** Cargo colour + remaining units still to deposit at the silo. */
  color: Int32Array
  amount: Int32Array
  /** Progress along the flight, in single-tile steps, and the total steps to the silo. */
  step: Int32Array
  steps: Int32Array
}

export function createShellStore(): ShellStore {
  const cap = 8
  return {
    count: 0,
    eid: new Int32Array(cap).fill(NONE),
    x: new Int32Array(cap),
    y: new Int32Array(cap),
    ox: new Int32Array(cap),
    oy: new Int32Array(cap),
    dx: new Int32Array(cap),
    dy: new Int32Array(cap),
    color: new Int32Array(cap),
    amount: new Int32Array(cap),
    step: new Int32Array(cap),
    steps: new Int32Array(cap).fill(1),
  }
}

function ensureShellCapacity(s: ShellStore, need: number): void {
  const cap = s.eid.length
  if (need <= cap) return
  let next = cap
  while (next < need) next *= 2
  s.eid = grow(s.eid, next, NONE)
  s.x = grow(s.x, next, 0)
  s.y = grow(s.y, next, 0)
  s.ox = grow(s.ox, next, 0)
  s.oy = grow(s.oy, next, 0)
  s.dx = grow(s.dx, next, 0)
  s.dy = grow(s.dy, next, 0)
  s.color = grow(s.color, next, 0)
  s.amount = grow(s.amount, next, 0)
  s.step = grow(s.step, next, 0)
  s.steps = grow(s.steps, next, 1)
}

/** Swap-remove shell `i`, despawning its render entity (order is not sim-significant). */
function removeShell(api: ModApi, store: ShellStore, i: number): void {
  const eid = store.eid[i]!
  if (eid !== NONE) api.despawn(eid)
  const last = --store.count
  if (i !== last) {
    store.eid[i] = store.eid[last]!
    store.x[i] = store.x[last]!
    store.y[i] = store.y[last]!
    store.ox[i] = store.ox[last]!
    store.oy[i] = store.oy[last]!
    store.dx[i] = store.dx[last]!
    store.dy[i] = store.dy[last]!
    store.color[i] = store.color[last]!
    store.amount[i] = store.amount[last]!
    store.step[i] = store.step[last]!
    store.steps[i] = store.steps[last]!
  }
}

/** Units of `color` currently stocked in silo `b`'s deposit slot (0 if it has no such slot). */
function siloStock(store: BuildingStore, b: number, color: number): number {
  const k = findSlot(store, b, color)
  if (k === NONE) return 0
  return store.slotCount[b * MAX_SLOTS + k]!
}

/** Deposit up to `amount` of `color` into silo `b`'s deposit slot; returns how many units landed. */
function depositIntoSilo(store: BuildingStore, b: number, color: number, amount: number): number {
  const k = findSlot(store, b, color)
  if (k === NONE) return 0
  const i = b * MAX_SLOTS + k
  const room = store.slotCap[i]! - store.slotCount[i]!
  const take = room < amount ? room : amount
  if (take > 0) store.slotCount[i] = store.slotCount[i]! + take
  return take
}

/**
 * Advance every shell one flight tick then fire every loaded, targeted cannon. Runs each tick; the
 * per-shell/per-cannon work is bounded index loops with no allocation (firing/landing go through the
 * stable {@link ModApi} lifecycle). A shell steps {@link SHELL_SPEED} tiles along its straight line;
 * on arrival it deposits into the silo losslessly — anything that doesn't fit parks the shell at the
 * silo and retries next tick, so a full silo backs cannons up rather than dropping cargo.
 */
function updateCannons(gw: GameWorld, api: ModApi, state: GameState): void {
  const { Position } = gw.components
  const cannons = state.cannons
  const shells = state.shells
  const buildings = state.buildings

  // 1) Advance shells (iterate backwards so a swap-remove never skips the moved-down entry).
  for (let i = shells.count - 1; i >= 0; i--) {
    const eid = shells.eid[i]!
    const next = shells.step[i]! + SHELL_SPEED
    const total = shells.steps[i]!
    if (next < total) {
      // Still en route: interpolate the logical tile along the line (integer, deterministic).
      shells.step[i] = next
      const ox = shells.ox[i]!
      const oy = shells.oy[i]!
      const nx = ox + Math.round(((shells.dx[i]! - ox) * next) / total)
      const ny = oy + Math.round(((shells.dy[i]! - oy) * next) / total)
      Position.prevX[eid] = shells.x[i]!
      Position.prevY[eid] = shells.y[i]!
      Position.x[eid] = nx
      Position.y[eid] = ny
      shells.x[i] = nx
      shells.y[i] = ny
      continue
    }
    // Arrived at the silo tile: try to deposit, losslessly.
    const dxT = shells.dx[i]!
    const dyT = shells.dy[i]!
    Position.prevX[eid] = shells.x[i]!
    Position.prevY[eid] = shells.y[i]!
    Position.x[eid] = dxT
    Position.y[eid] = dyT
    shells.x[i] = dxT
    shells.y[i] = dyT
    shells.step[i] = total
    const b = buildingAt(buildings, dxT, dyT)
    if (b === NONE) {
      // Silo is gone — drop the shell (its cargo is lost with its destination).
      removeShell(api, shells, i)
      continue
    }
    const landed = depositIntoSilo(buildings, b, shells.color[i]!, shells.amount[i]!)
    const left = shells.amount[i]! - landed
    if (left <= 0) removeShell(api, shells, i)
    else shells.amount[i] = left // silo full: park here and retry next tick
  }

  // 2) Fire loaded, targeted cannons.
  for (let c = 0; c < cannons.count; c++) {
    if (cannons.timer[c]! > 0) {
      cannons.timer[c] = cannons.timer[c]! - 1
      continue
    }
    if (!cannons.enabled[c]) continue // player paused this cannon
    const tx = cannons.tx[c]!
    const ty = cannons.ty[c]!
    if (tx === NONE) continue // unlinked — no target yet
    const ox = cannons.cx[c]!
    const oy = cannons.cy[c]!
    // Range gate: a silo beyond the cannon's reach can be linked but never fired at.
    if (Math.max(Math.abs(tx - ox), Math.abs(ty - oy)) > CANNON_RANGE) continue
    const cb = buildingAt(buildings, ox, oy)
    if (cb === NONE) continue // cannon building removed out from under the record
    const color = cannons.color[c]!
    const need = cannons.payload[c]!
    const k = findSlot(buildings, cb, color)
    if (k === NONE) continue
    const si = cb * MAX_SLOTS + k
    if (buildings.slotCount[si]! < need) continue // not loaded yet
    const sb = buildingAt(buildings, tx, ty)
    if (sb === NONE || !buildings.silo[sb]) continue // target must be a live silo
    // The silo must be EMPTY of the payload before the next shot lands (a burst-delivery model: one
    // load sits there until output ports drain it, then the cannon tops it up again).
    if (siloStock(buildings, sb, color) > 0) continue
    // Fire: consume the payload, launch a shell, and start the reload timer.
    buildings.slotCount[si] = buildings.slotCount[si]! - need
    const dist = Math.max(Math.abs(tx - ox), Math.abs(ty - oy))
    const eid = api.spawn({
      pos: { x: ox, y: oy },
      sprite: sprite(SHAPE_CIRCLE, 0),
      color,
      width: 1,
      height: 1,
    })
    ensureShellCapacity(shells, shells.count + 1)
    const s = shells.count++
    shells.eid[s] = eid
    shells.x[s] = ox
    shells.y[s] = oy
    shells.ox[s] = ox
    shells.oy[s] = oy
    shells.dx[s] = tx
    shells.dy[s] = ty
    shells.color[s] = color
    shells.amount[s] = need
    shells.step[s] = 0
    shells.steps[s] = Math.max(1, dist)
    cannons.timer[c] = CANNON_FIRE_EVERY
  }
}

// --- Systems ----------------------------------------------------------------

/**
 * Build the base-game systems bound to `state` and `api`. Returned in run order: drain
 * commands first (so a belt placed this tick is live), advance the belt grid + crafters, then
 * evaluate villages and research (each on their own slow cadence). The closures are created once at init — never
 * per tick — so the hot path stays allocation-free; entity lifecycle goes through the stable
 * {@link ModApi} (`spawn`/`despawn`).
 */
export function createGameSystems(state: GameState, api: ModApi): System[] {
  const commandSystem: System = (gw) => {
    const cmds = gw.commands
    for (let i = 0; i < cmds.length; i++) {
      applyCommand(gw, api, state, cmds[i] as unknown as GameCommand)
    }
    // Placements defer their O(n) topology rebuild via `topoDirty`, so a batch of N commands
    // (blueprint paste, map build) rebuilds once here instead of N times — O(n) not O(n²). The
    // belt system reads `nbr`/`order` only after this, so nothing observes the deferral.
    if (state.grid.topoDirty) {
      rebuildTopology(state.grid)
      state.grid.topoDirty = 0
    }
    // Reuse the array; never reallocate on the hot path.
    cmds.length = 0
  }

  const beltSystem: System = (gw) => {
    updateBelts(
      gw,
      api,
      state.grid,
      state.buildings,
      state.treasury,
      state.prices,
      state.deposits,
      state.terrain,
    )
  }

  const villageSystem: System = () => {
    updateVillages(state)
  }

  const upkeepSystem: System = () => {
    updateUpkeep(state)
  }

  const researchSystem: System = () => {
    updateResearch(state)
  }

  const cannonSystem: System = (gw) => {
    updateCannons(gw, api, state)
  }

  return [commandSystem, beltSystem, cannonSystem, villageSystem, researchSystem, upkeepSystem]
}
