/**
 * Base-game ("mod zero") sim logic: conveyor belts, the buildings that hold resource
 * stockpiles, the input/output ports that bridge those buildings to the belts, the
 * splitters that fan items out at junctions, the command handlers that turn player intents
 * into sim state, and the systems that drive them.
 *
 * IMPORTANT: kept byte-for-byte identical to the headless copy
 * (`apps/headless/gameLogic.ts`) so the headless run and the on-screen world behave
 * the same — this is sim-critical for determinism. Edit both together. (The intended
 * long-term home is a sandboxed /content script receiving the engine via `ModApi`;
 * until that sandbox lands, the apps wire this in directly, mirroring `scene.ts`.)
 *
 * A belt is a grid of directed tiles. Each tile faces one of four directions and, on a
 * move-cycle, hands the item riding it to the neighbour tile it faces — but only if that
 * neighbour is itself a belt tile and is (or is becoming) empty, so items back up behind
 * anything ahead of them.
 *
 * Resources live in *buildings*, not on the belt: a building owns an internal stockpile of
 * one or more resources (each capped). A *producer* building also generates a resource into
 * its own stockpile every N ticks. Belts reach a building through two belt-tile modifiers
 * linked to an orthogonally adjacent building: an *output* port drains a resource out of the
 * building onto its own tile every N ticks; an *input* port deposits an arriving item into
 * the building — but only if the building accepts that resource (else the item backs up). A
 * *splitter* tile round-robins its arriving item across every adjacent belt tile except the
 * one it came from, skipping any that are full. The resource an item carries is identified by
 * its colour.
 *
 * Everything is integer-grid and tick-driven, so identical inputs produce byte-identical
 * state. The belt grid and the building store keep their data in flat Structure-of-Arrays
 * buffers grown only at placement time; the per-tick update never allocates (bar the
 * occasional item spawn).
 */
import {
  spawnEntity,
  despawnEntity,
  enqueueCommand,
  type GameWorld,
  type System,
} from '@factory/engine/core'

// --- Belt grid --------------------------------------------------------------

/**
 * Per-tile feature stored in {@link BeltGrid.kind}. Exported so the (read-only) UI
 * inspector can interpret a hovered belt tile; the sim itself uses them internally.
 */
export const KIND_PLAIN = 0
export const KIND_OUTPUT = 1
export const KIND_INPUT = 2
export const KIND_SPLITTER = 3

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
const SHAPE_PRODUCER = 5
const SHAPE_TERRAIN = 6
function sprite(shape: number, orient: number): number {
  return shape * 4 + orient
}

/**
 * Glyph for a terrain tile (the engine draws shape 6 as a flat, full-tile fill). Terrain is
 * a passive background layer placed by the starting scene; it produces nothing on its own
 * but gates which resource producers may be built on top (see {@link terrainTypeOf} and the
 * `place_producer` handler). Exported so the scene spawner can paint terrain patches.
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
  /** Splitter tiles: round-robin cursor (next direction to try). */
  rr: Int8Array
  /** Track entity id drawn under each tile (re-oriented when a tile's facing changes). */
  trackEid: Int32Array
  /** Neighbour belt-tile id per direction: nbr[t*4 + d], or NONE. Rebuilt on placement. */
  nbr: Int32Array
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
    rr: new Int8Array(cap),
    trackEid: new Int32Array(cap).fill(NONE),
    nbr: new Int32Array(cap * 4).fill(NONE),
    order: new Int32Array(cap),
    period: new Int32Array(cap).fill(Math.max(1, moveEvery)),
    dueEvery: new Int32Array(cap).fill(1),
    moveEvery: Math.max(1, moveEvery),
    moveTimer: 0,
    moveCount: 0,
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
  g.rr = grow8(g.rr, next, 0)
  g.trackEid = grow(g.trackEid, next, NONE)
  g.nbr = grow(g.nbr, next * 4, NONE)
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
  g.trackEid[t] = spawnEntity(gw, {
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
  const { nbr, order } = g
  for (let t = 0; t < n; t++) {
    for (let d = 0; d < 4; d++) {
      nbr[t * 4 + d] = tileAt(g, g.tx[t]! + DX[d]!, g.ty[t]! + DY[d]!)
    }
  }

  // out-degree over successor edges (PLAIN/OUTPUT -> faced neighbour; SPLITTER -> all
  // neighbours; INPUT -> none). Kahn's algorithm peels sinks first.
  const outDeg = new Int32Array(n)
  for (let t = 0; t < n; t++) outDeg[t] = successorCount(g, t)

  let head = 0
  let tail = 0
  for (let t = 0; t < n; t++) {
    if (outDeg[t] === 0) order[tail++] = t
  }
  while (head < tail) {
    const t = order[head++]!
    // Decrement out-degree of every predecessor that feeds t.
    for (let s = 0; s < n; s++) {
      if (feeds(g, s, t) && outDeg[s]! > 0) {
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
 * Whether s feeds t as a *successor* (downstream) edge, used to order tiles sinks-first.
 * A splitter never counts an edge to a neighbour that itself feeds the splitter: that
 * neighbour is the source, not a sink. Counting it would forge a 2-cycle (splitter <-> its
 * feed tile) that defeats the topological sort, leaving the feed belt to be processed
 * upstream-first — which makes an item cascade across every feed tile in a single cycle
 * (it teleports from the source straight to the splitter instead of riding the belt).
 */
function feeds(g: BeltGrid, s: number, t: number): boolean {
  if (!hasForwardEdge(g, s, t)) return false
  if (g.kind[s] === KIND_SPLITTER && hasForwardEdge(g, t, s)) return false
  return true
}

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
 * Every resource-holding building as flat parallel arrays indexed by a dense building id.
 * Producers generate a resource into one of their slots; output/input ports (see
 * {@link BeltGrid.portBuilding}) drain/fill these slots. Buildings without a stockpile (the
 * apple orchard, plain scenery) are never registered here. Lives outside the ECS world, like
 * {@link BeltGrid}; grown only at registration, read by index on the hot path.
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
  /** Produced resource colour, or NONE for a non-producer. */
  prodColor: Int32Array
  /** Producer cadence: make one unit every N ticks. */
  prodEvery: Int32Array
  /** Ticks since this producer last made a unit. */
  prodTimer: Int32Array
  /** Number of active stockpile slots (<= MAX_SLOTS). */
  slotN: Int32Array
  /** Flattened per-slot resource colour: [id*MAX_SLOTS + k]. */
  slotColor: Int32Array
  /** Flattened per-slot current count. */
  slotCount: Int32Array
  /** Flattened per-slot capacity. */
  slotCap: Int32Array
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
    prodColor: new Int32Array(cap).fill(NONE),
    prodEvery: new Int32Array(cap).fill(1),
    prodTimer: new Int32Array(cap),
    slotN: new Int32Array(cap),
    slotColor: new Int32Array(cap * MAX_SLOTS),
    slotCount: new Int32Array(cap * MAX_SLOTS),
    slotCap: new Int32Array(cap * MAX_SLOTS),
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
  s.prodColor = grow(s.prodColor, next, NONE)
  s.prodEvery = grow(s.prodEvery, next, 1)
  s.prodTimer = grow(s.prodTimer, next, 0)
  s.slotN = grow(s.slotN, next, 0)
  s.slotColor = grow(s.slotColor, next * MAX_SLOTS, 0)
  s.slotCount = grow(s.slotCount, next * MAX_SLOTS, 0)
  s.slotCap = grow(s.slotCap, next * MAX_SLOTS, 0)
}

/** A stockpile slot definition: which resource (colour) and how much it can hold. */
export interface AcceptSlot {
  readonly color: number
  readonly cap: number
}

/**
 * Register a resource-holding building: record its footprint (every tile maps back to it),
 * its optional production (`prodColor` NONE for a pure store), and one stockpile slot per
 * accepted resource. Returns the dense building id. Off the hot path (placement/scene only).
 */
export function registerBuilding(
  store: BuildingStore,
  eid: number,
  x: number,
  y: number,
  w: number,
  h: number,
  prodColor: number,
  prodEvery: number,
  accepts: readonly AcceptSlot[],
): number {
  ensureBuildingCapacity(store, store.count + 1)
  const b = store.count++
  store.eid[b] = eid
  store.bx[b] = x
  store.by[b] = y
  store.bw[b] = w
  store.bh[b] = h
  store.prodColor[b] = prodColor
  store.prodEvery[b] = Math.max(1, prodEvery)
  store.prodTimer[b] = 0
  let n = 0
  for (let j = 0; j < accepts.length && n < MAX_SLOTS; j++) {
    const i = b * MAX_SLOTS + n
    store.slotColor[i] = accepts[j]!.color
    store.slotCount[i] = 0
    store.slotCap[i] = Math.max(0, accepts[j]!.cap)
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

/** Slot index (0..slotN) holding `color` in building `b`, or NONE. Bounded scan. */
function findSlot(store: BuildingStore, b: number, color: number): number {
  const n = store.slotN[b]!
  for (let k = 0; k < n; k++) {
    if (store.slotColor[b * MAX_SLOTS + k] === color) return k
  }
  return NONE
}

/** First slot of building `b` that holds at least one unit, or NONE. Fixed slot order. */
function firstNonEmptySlot(store: BuildingStore, b: number): number {
  const n = store.slotN[b]!
  for (let k = 0; k < n; k++) {
    if (store.slotCount[b * MAX_SLOTS + k]! > 0) return k
  }
  return NONE
}

/**
 * Link the belt port at tile `t` to the first building (scanning N,E,S,W in order) whose
 * footprint sits on the orthogonally adjacent tile, or NONE if none borders it. Off the hot
 * path (port placement, or a re-link when a building is placed beside an existing port).
 */
function linkPort(g: BeltGrid, store: BuildingStore, t: number): void {
  const x = g.tx[t]!
  const y = g.ty[t]!
  for (let d = 0; d < 4; d++) {
    const b = buildingAt(store, x + DX[d]!, y + DY[d]!)
    if (b !== NONE) {
      g.portBuilding[t] = b
      return
    }
  }
  g.portBuilding[t] = NONE
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

// --- Per-tick systems -------------------------------------------------------

/**
 * Advance items one tile in downstream-first order, then let inputs deposit what arrived
 * into their linked building. Processing sinks before their feeders means a tile is vacated
 * before the tile behind it is visited, so a packed run shuffles forward one tile in a
 * single pass.
 */
function stepBelts(gw: GameWorld, g: BeltGrid, store: BuildingStore): void {
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

  // Inputs deposit the item now sitting on their tile into the building they feed, if it
  // accepts that resource (matched by colour) and has room. Otherwise the item stays put and
  // backs the belt up (an unlinked input, an unaccepted resource, or a full slot all block).
  for (let t = 0; t < n; t++) {
    if (kind[t] !== KIND_INPUT || slot[t] === NONE) continue
    const b = portBuilding[t]!
    if (b === NONE) continue
    const eid = slot[t]!
    const k = findSlot(store, b, Renderable.color[eid]!)
    if (k === NONE) continue
    const si = b * MAX_SLOTS + k
    if (store.slotCount[si]! >= store.slotCap[si]!) continue
    store.slotCount[si] = store.slotCount[si]! + 1
    despawnEntity(gw, eid)
    slot[t] = NONE
  }
}

/**
 * Resource producers (farm, woodcutter, mine) make one unit of their resource into their own
 * stockpile slot every `prodEvery` ticks, capped — overflow is discarded. Runs every tick,
 * independent of the belt move cadence; allocation-free.
 */
function updateBuildingProduction(store: BuildingStore): void {
  const n = store.count
  for (let b = 0; b < n; b++) {
    const pc = store.prodColor[b]!
    if (pc === NONE) continue
    const timer = store.prodTimer[b]! + 1
    if (timer < store.prodEvery[b]!) {
      store.prodTimer[b] = timer
      continue
    }
    store.prodTimer[b] = 0
    const k = findSlot(store, b, pc)
    if (k === NONE) continue
    const si = b * MAX_SLOTS + k
    if (store.slotCount[si]! < store.slotCap[si]!) store.slotCount[si] = store.slotCount[si]! + 1
  }
}

/**
 * Output ports drain one unit from their linked building onto their own belt tile every
 * `portEvery` ticks, but only when that tile is free — a full belt backs the port up. The
 * drained resource is the first non-empty stockpile slot (fixed slot order); the emitted item
 * carries that slot's colour. Allocation-free except for the occasional spawn. Runs every tick,
 * independent of the move cadence.
 */
function extractFromOutputs(gw: GameWorld, g: BeltGrid, store: BuildingStore): void {
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
    const k = firstNonEmptySlot(store, b)
    if (k === NONE) continue
    const si = b * MAX_SLOTS + k
    store.slotCount[si] = store.slotCount[si]! - 1
    slot[t] = spawnEntity(gw, {
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
 * Tick the whole game: move items on the move-cycle, then let buildings produce into their
 * stores and output ports drain those stores onto the belts. Production runs before drain so
 * a unit made this tick can leave the same tick if the belt is free.
 */
function updateBelts(gw: GameWorld, g: BeltGrid, store: BuildingStore): void {
  if (++g.moveTimer >= g.moveEvery) {
    g.moveTimer = 0
    stepBelts(gw, g, store)
    g.moveCount++
  }
  updateBuildingProduction(store)
  extractFromOutputs(gw, g, store)
}

// --- Game state -------------------------------------------------------------

/** Mutable per-world game state owned by the base game (not by the engine). */
export interface GameState {
  /** The belt network. */
  readonly grid: BeltGrid
  /** The passive terrain layer that gates where resource producers may be built. */
  readonly terrain: TerrainGrid
  /** The resource-holding buildings (producers and stores). */
  readonly buildings: BuildingStore
}

export function createGameState(moveEvery = 60): GameState {
  return { grid: createBeltGrid(moveEvery), terrain: new Map(), buildings: createBuildingStore() }
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
interface PlaceBuildingCommand {
  readonly type: 'place_building'
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly color: number
  /** Resources this building stockpiles (from input ports); omitted/empty for plain scenery. */
  readonly accepts?: readonly AcceptSlot[]
}

/** Place a conveyor running from tile A to tile B. */
interface PlaceBeltCommand {
  readonly type: 'place_belt'
  readonly ax: number
  readonly ay: number
  readonly bx: number
  readonly by: number
  readonly color: number
  readonly moveEvery: number
}

/**
 * Place an input or output port on the belt tile at (x, y). The port links to an
 * orthogonally adjacent building: an output drains it every `spawnEvery` ticks; an input
 * deposits arriving items into it when accepted. A port off any belt is dropped.
 */
interface PlacePortCommand {
  readonly type: 'place_port'
  readonly x: number
  readonly y: number
  readonly port: 'output' | 'input'
  /** Color of the port's building footprint. */
  readonly color: number
  /** Output ports only: drain the linked building every N ticks. */
  readonly spawnEvery?: number
}

/** Mark the belt tile at (x, y) a splitter. A splitter off any belt is dropped. */
interface PlaceSplitterCommand {
  readonly type: 'place_splitter'
  readonly x: number
  readonly y: number
  /** Color of the splitter's footprint. */
  readonly color: number
}

/**
 * Place a resource producer (farm/woodcutter/mine) as a building with its top-left at (x, y).
 * It makes one unit of `itemColor` every `produceEvery` ticks into its own stockpile (capped
 * at `storageCap`), which an adjacent output port can drain onto a belt. If
 * `requiresTerrainType` is set (non-zero), the placement is dropped unless the terrain layer
 * at (x, y) matches it — that is how terrain enables/disables a producer.
 */
interface PlaceProducerCommand {
  readonly type: 'place_producer'
  readonly x: number
  readonly y: number
  /** Footprint size. */
  readonly w: number
  readonly h: number
  /** Color of the production building's footprint. */
  readonly color: number
  /** Color (resource identity) of the produced item. */
  readonly itemColor: number
  /** Produce a fresh unit every N ticks. */
  readonly produceEvery: number
  /** Maximum units the internal store can hold. */
  readonly storageCap: number
  /**
   * Terrain type (see {@link terrainTypeOf}) this producer needs under it, or
   * {@link TERRAIN_NONE}/omitted for a producer that may sit anywhere.
   */
  readonly requiresTerrainType?: number
}

type GameCommand =
  | PlaceBuildingCommand
  | PlaceBeltCommand
  | PlacePortCommand
  | PlaceSplitterCommand
  | PlaceProducerCommand

/** Queue a building placement (applied next tick). */
export function enqueuePlaceBuilding(gw: GameWorld, cmd: Omit<PlaceBuildingCommand, 'type'>): void {
  enqueueCommand(gw, { type: 'place_building', ...cmd })
}

/** Queue a belt placement (applied next tick). */
export function enqueuePlaceBelt(gw: GameWorld, cmd: Omit<PlaceBeltCommand, 'type'>): void {
  enqueueCommand(gw, { type: 'place_belt', ...cmd })
}

/** Queue an input/output port placement onto a belt tile (applied next tick). */
export function enqueuePlacePort(gw: GameWorld, cmd: Omit<PlacePortCommand, 'type'>): void {
  enqueueCommand(gw, { type: 'place_port', ...cmd })
}

/** Queue a splitter placement onto a belt tile (applied next tick). */
export function enqueuePlaceSplitter(gw: GameWorld, cmd: Omit<PlaceSplitterCommand, 'type'>): void {
  enqueueCommand(gw, { type: 'place_splitter', ...cmd })
}

/** Queue a production building placement (applied next tick). */
export function enqueuePlaceProducer(gw: GameWorld, cmd: Omit<PlaceProducerCommand, 'type'>): void {
  enqueueCommand(gw, { type: 'place_producer', ...cmd })
}

function applyCommand(gw: GameWorld, state: GameState, cmd: GameCommand): void {
  const g = state.grid
  switch (cmd.type) {
    case 'place_building': {
      const eid = spawnEntity(gw, {
        pos: { x: cmd.x, y: cmd.y },
        color: cmd.color,
        width: cmd.w,
        height: cmd.h,
      })
      if (cmd.accepts && cmd.accepts.length > 0) {
        registerBuilding(state.buildings, eid, cmd.x, cmd.y, cmd.w, cmd.h, NONE, 1, cmd.accepts)
        relinkUnlinkedPorts(g, state.buildings)
      }
      return
    }
    case 'place_belt': {
      const { dx, dy, length } = projectBelt(cmd.ax, cmd.ay, cmd.bx, cmd.by)
      const face = dirOf(dx, dy)
      const period = Math.max(1, cmd.moveEvery)
      for (let i = 0; i < length; i++) {
        addOrAimTile(gw, g, cmd.ax + dx * i, cmd.ay + dy * i, face, cmd.color, period)
      }
      rebuildTopology(g)
      recomputeCadence(g)
      return
    }
    case 'place_port': {
      const t = tileAt(g, cmd.x, cmd.y)
      if (t === NONE) return // a port must sit on a belt; off-belt placements are dropped.
      if (cmd.port === 'output') {
        g.kind[t] = KIND_OUTPUT
        g.portEvery[t] = Math.max(1, cmd.spawnEvery ?? 20)
        g.portTimer[t] = 0
      } else {
        g.kind[t] = KIND_INPUT
      }
      linkPort(g, state.buildings, t)
      rebuildTopology(g)
      spawnEntity(gw, {
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
      g.kind[t] = KIND_SPLITTER
      g.rr[t] = 0
      rebuildTopology(g)
      spawnEntity(gw, {
        pos: { x: cmd.x, y: cmd.y },
        sprite: sprite(SHAPE_SPLITTER, g.face[t]!),
        color: cmd.color,
        width: 1,
        height: 1,
      })
      return
    }
    case 'place_producer': {
      // Terrain gate: a producer that needs a specific ground is dropped off the matching
      // terrain (an unrestricted producer carries TERRAIN_NONE and places anywhere).
      const need = cmd.requiresTerrainType ?? TERRAIN_NONE
      if (need !== TERRAIN_NONE && terrainTypeAt(state.terrain, cmd.x, cmd.y) !== need) return
      const eid = spawnEntity(gw, {
        pos: { x: cmd.x, y: cmd.y },
        sprite: sprite(SHAPE_PRODUCER, 0),
        color: cmd.color,
        width: cmd.w,
        height: cmd.h,
      })
      registerBuilding(
        state.buildings,
        eid,
        cmd.x,
        cmd.y,
        cmd.w,
        cmd.h,
        cmd.itemColor,
        cmd.produceEvery,
        [{ color: cmd.itemColor, cap: cmd.storageCap }],
      )
      relinkUnlinkedPorts(g, state.buildings)
      return
    }
  }
}

// --- Systems ----------------------------------------------------------------

/**
 * Build the base-game systems bound to `state`. Returned in run order: drain commands
 * first (so a belt placed this tick is live), then advance the belt grid + buildings.
 */
export function createGameSystems(state: GameState): System[] {
  const commandSystem: System = (gw) => {
    const cmds = gw.commands
    for (let i = 0; i < cmds.length; i++) {
      applyCommand(gw, state, cmds[i] as unknown as GameCommand)
    }
    // Reuse the array; never reallocate on the hot path.
    cmds.length = 0
  }

  const beltSystem: System = (gw) => {
    updateBelts(gw, state.grid, state.buildings)
  }

  return [commandSystem, beltSystem]
}
