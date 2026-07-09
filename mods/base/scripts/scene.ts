/**
 * The starting scene for the base game ("mod zero"). Spawns the starting world through the
 * stable {@link ModApi} — the same surface a third-party mod gets — and populates the mod-owned
 * {@link GameState} (terrain + building store) the systems read.
 *
 * The layout is driven by a chosen `scenario` prototype and the world's seeded RNG, so each new
 * game is varied yet fully reproducible for a given seed + scenario:
 *   - one 2x2 "village" centered on the origin,
 *   - a 6x6 orchard of apple trees with its corner at (+50, +50), and
 *   - the scenario's resource deposits (bauxite, silica, coal, titanium, rare-earth, oil) scattered
 *     as terrain patches around the village — their positions/sizes drawn from the RNG within the
 *     scenario's bands — that gate which resource producers can be built on top of them, plus an
 *     optional "starting kit" of stock granted to the village.
 *
 * Reads color/size from the loaded prototypes when present, falling back to sane defaults so the
 * scene still builds if a prototype is missing. All randomness goes through {@link ModApi.randomInt}
 * (the world's seeded RNG) — never `Math.random` — so the scene stays deterministic.
 *
 * For every object it spawns, it emits a `base:spawn` event carrying the prototype id and anchor
 * tile. The host (the renderer) uses this — read-only — to name tiles for the inspector; the
 * headless runner has no listener, so it is a no-op there. This keeps the sim→render flow one-way:
 * the scene never knows about the UI.
 */
import type { ModApi } from '@factory/engine/scripting'
import {
  tileKey,
  terrainTypeOf,
  registerBuilding,
  registerVillage,
  creditTreasury,
  priceOf,
  MAX_SLOTS,
  TERRAIN_SPRITE,
  ROLE_DEPOSIT,
  ROLE_DRAIN,
  type BuildingSlot,
  type BuildingStore,
  type GameState,
  type PriceTable,
  type TreasuryStore,
  type VillageStageConfig,
} from './sim.ts'

/** The prototype shape this scene reads (only a handful of fields are consulted). */
export type SceneProto = Record<string, unknown>

/** Config passed to {@link spawnScene}: which starting scenario to lay out, and rule overrides. */
export interface SceneConfig {
  /** Scenario prototype id (e.g. `scenario.abundant`); falls back to {@link DEFAULT_SCENARIO}. */
  readonly scenario?: string
  /**
   * Build-refund setting for the new game, in permille (1000 = full refund). New-game screens set
   * this; omitted keeps the sim default (see {@link createGameConfig}). Carried into
   * {@link GameState.config} so it saves and stays deterministic.
   */
  readonly refundPermille?: number
}

/** The scenario used when none is chosen (headless runs, older callers). */
export const DEFAULT_SCENARIO = 'scenario.abundant'

/** Where the apple orchard's corner sits, and how many tiles on a side. */
const ORCHARD_X = 50
const ORCHARD_Y = 50
const ORCHARD_SIZE = 6

/** Gap (tiles) kept between deposit cells and around the reserved village/orchard rects. */
const MARGIN = 2

/** Fallback deposit terrain ids + colours, used only if the chosen scenario has no `deposits`. */
const FALLBACK_DEPOSITS: ReadonlyArray<{ id: string; color: number }> = [
  { id: 'terrain.bauxite_deposit', color: 0xb08d57 },
  { id: 'terrain.silica_quarry', color: 0xe8d9a0 },
  { id: 'terrain.coal_seam', color: 0x3c3c44 },
  { id: 'terrain.titanium_deposit', color: 0x9aa7b0 },
  { id: 'terrain.rare_earth_deposit', color: 0xa86fb8 },
  { id: 'terrain.oil_field', color: 0x2a2a38 },
]

/** An axis-aligned tile rectangle (top-left + size), used for overlap tests during layout. */
interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * A scenario's deposit-richness band. `null` means the scenario declares *infinite* richness (the
 * `richness` field omitted, or `"infinite"`) — extraction never depletes, the original behaviour.
 * A finite band rolls a per-tile richness from `[min, max]` via the seeded RNG.
 */
type RichnessBand = { readonly min: number; readonly max: number } | null

/**
 * An extra settlement beyond the origin spaceport: which `village` prototype to place, and the
 * Chebyshev distance band (in tiles from the origin) its ring of candidate anchors is drawn from.
 * Farther bands make its distinct goods a genuine routing problem (G3).
 */
interface SettlementConfig {
  readonly building: string
  readonly distance: { readonly min: number; readonly max: number }
}

/** A scenario's parsed win goal: reach `village`'s 0-based `stage`. `null` when none is authored. */
type GoalConfig = { readonly village: string; readonly stage: number } | null

/** An inclusive integer `{ min, max }` band drawn from the seeded RNG. */
interface Band {
  readonly min: number
  readonly max: number
}

/**
 * A generated base-terrain biome: which terrain prototype to paint as organic blobs, how much of the
 * world it covers (`coverage` in permille of the world's tile area), and each blob's target tile-count
 * `size` band. Water-type biomes (with `blocksBuild`) become impassable; the rest are cosmetic ground.
 */
interface BiomeConfig {
  readonly terrain: string
  readonly coverage: number
  readonly size: Band
}

/** The bounded region (centred on the origin) that base terrain + deposits generate within. */
interface WorldSize {
  readonly w: number
  readonly h: number
}

/** The scenario layout params the scene consumes, after parsing (with fallbacks). */
interface ScenarioConfig {
  readonly deposits: readonly string[]
  /** Bounded generation rect, centred on the origin — the finite world the map is laid out in. */
  readonly worldSize: WorldSize
  /** How many separate patches each deposit type scatters (organic blobs). */
  readonly frequency: Band
  /** Each deposit blob's target tile count (an organic blob, not a square side). */
  readonly patch: Band
  readonly spread: Band
  /** Per-deposit-tile richness band, or `null` for an infinite (never-depleting) scenario. */
  readonly richness: RichnessBand
  /** Base-terrain biomes painted across the world before deposits (water + cosmetic ground). */
  readonly biomes: readonly BiomeConfig[]
  readonly startingKit: readonly { readonly item: string; readonly amount: number }[]
  readonly startingTreasury: readonly { readonly item: string; readonly amount: number }[]
  /** Extra settlements (beyond the origin spaceport) scattered at increasing distance bands. */
  readonly settlements: readonly SettlementConfig[]
  /** The win condition (G5): which settlement to raise to which stage. `null` when the scenario has none. */
  readonly goal: GoalConfig
}

function colorOf(proto: SceneProto | undefined, fallback: number): number {
  return typeof proto?.color === 'number' ? proto.color : fallback
}

function sizeDim(proto: SceneProto | undefined, key: 'w' | 'h', fallback: number): number {
  const size = proto?.size
  if (size && typeof size === 'object') {
    const v = (size as Record<string, unknown>)[key]
    if (typeof v === 'number') return v
  }
  return fallback
}

/** Read a `{ min, max }` positive-integer range off a scenario field, clamped to sane fallbacks. */
function rangeOf(
  proto: SceneProto | undefined,
  field: string,
  fbMin: number,
  fbMax: number,
): { min: number; max: number } {
  const raw = proto?.[field]
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>
    const min = typeof r.min === 'number' ? Math.max(1, Math.floor(r.min)) : fbMin
    const max = typeof r.max === 'number' ? Math.max(min, Math.floor(r.max)) : Math.max(min, fbMax)
    return { min, max }
  }
  return { min: fbMin, max: fbMax }
}

/**
 * Parse a scenario's `richness` into a {@link RichnessBand}: a `{ min, max }` object → a finite band
 * (positive integers, min ≤ max); omitted or the string `"infinite"` → `null` (infinite, so the
 * scene rolls no richness and extraction never depletes — the pre-G1 behaviour). Validation proper
 * lives host-side in `content.ts`; this stays lenient so a malformed field just falls back to infinite.
 */
function richnessBandOf(proto: SceneProto | undefined): RichnessBand {
  const raw = proto?.richness
  if (raw === undefined || raw === 'infinite') return null
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>
    if (typeof r.min === 'number' && typeof r.max === 'number') {
      const min = Math.max(1, Math.floor(r.min))
      const max = Math.max(min, Math.floor(r.max))
      return { min, max }
    }
  }
  return null
}

/**
 * Resolve the chosen scenario prototype into the layout params the scene lays out from, falling
 * back to defaults so the scene still builds if the scenario is missing a field (or absent).
 */
function scenarioConfigOf(
  getProto: (id: string) => SceneProto | undefined,
  id: string,
): ScenarioConfig {
  const proto = getProto(id)
  const deposits = Array.isArray(proto?.deposits)
    ? proto.deposits.filter((d): d is string => typeof d === 'string')
    : FALLBACK_DEPOSITS.map((d) => d.id)
  return {
    deposits: deposits.length > 0 ? deposits : FALLBACK_DEPOSITS.map((d) => d.id),
    worldSize: worldSizeOf(proto),
    frequency: rangeOf(proto, 'frequency', 1, 1),
    patch: rangeOf(proto, 'patchSize', 12, 20),
    spread: rangeOf(proto, 'spread', 6, 18),
    richness: richnessBandOf(proto),
    biomes: biomesOf(proto),
    startingKit: flowListOf(proto, 'startingKit'),
    startingTreasury: flowListOf(proto, 'startingTreasury'),
    settlements: settlementsOf(proto),
    goal: goalOf(proto),
  }
}

/** Default world extent when a scenario omits `worldSize`. */
const DEFAULT_WORLD: WorldSize = { w: 120, h: 120 }

/**
 * Read a scenario's `worldSize` — the bounded generation rect centred on the origin — clamped to a
 * sane positive even-ish size, falling back to {@link DEFAULT_WORLD}. Stays lenient (a malformed
 * field just falls back); authoritative validation lives host-side in `content.ts`.
 */
function worldSizeOf(proto: SceneProto | undefined): WorldSize {
  const raw = proto?.worldSize
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>
    const w = typeof r.w === 'number' ? Math.max(8, Math.floor(r.w)) : DEFAULT_WORLD.w
    const h = typeof r.h === 'number' ? Math.max(8, Math.floor(r.h)) : DEFAULT_WORLD.h
    return { w, h }
  }
  return DEFAULT_WORLD
}

/**
 * Parse a scenario's `biomes` list: each `{ terrain, coverage, size: { min, max } }`. Malformed
 * entries are skipped, so a bad field just yields no base terrain. `coverage` is clamped to a
 * non-negative integer (permille of world area); `size` to a positive-integer band.
 */
function biomesOf(proto: SceneProto | undefined): BiomeConfig[] {
  const raw = Array.isArray(proto?.biomes) ? (proto.biomes as unknown[]) : []
  const out: BiomeConfig[] = []
  for (const b of raw) {
    const e = (b ?? {}) as Record<string, unknown>
    if (typeof e.terrain !== 'string') continue
    const coverage = typeof e.coverage === 'number' ? Math.max(0, Math.floor(e.coverage)) : 0
    if (coverage === 0) continue
    out.push({ terrain: e.terrain, coverage, size: rangeOf(e, 'size', 12, 24) })
  }
  return out
}

/**
 * Parse a scenario's `settlements` list (extra villages beyond the origin spaceport): each entry a
 * `{ building, distance: { min, max } }`. Malformed entries are skipped, so a bad field just yields
 * no extra settlements (validation proper lives host-side in `content.ts`). The distance band is
 * clamped to positive integers with min ≤ max.
 */
function settlementsOf(proto: SceneProto | undefined): SettlementConfig[] {
  const raw = Array.isArray(proto?.settlements) ? (proto.settlements as unknown[]) : []
  const out: SettlementConfig[] = []
  for (const s of raw) {
    const e = (s ?? {}) as Record<string, unknown>
    if (typeof e.building !== 'string') continue
    const d = (e.distance ?? {}) as Record<string, unknown>
    if (typeof d.min !== 'number' || typeof d.max !== 'number') continue
    const min = Math.max(1, Math.floor(d.min))
    const max = Math.max(min, Math.floor(d.max))
    out.push({ building: e.building, distance: { min, max } })
  }
  return out
}

/**
 * Parse a scenario's `goal` (win condition): reach village `goal.village`'s stage `goal.stage`.
 * Malformed or absent → `null` (no goal). Stays lenient — validation proper lives host-side in
 * `content.ts`; this just clamps the stage to a non-negative integer.
 */
function goalOf(proto: SceneProto | undefined): GoalConfig {
  const raw = proto?.goal
  if (!raw || typeof raw !== 'object') return null
  const g = raw as Record<string, unknown>
  if (typeof g.village !== 'string' || typeof g.stage !== 'number') return null
  return { village: g.village, stage: Math.max(0, Math.floor(g.stage)) }
}

/** Parse a `{ item, amount }[]` flow list off a scenario field, skipping malformed entries. */
function flowListOf(
  proto: SceneProto | undefined,
  field: string,
): { item: string; amount: number }[] {
  const raw = Array.isArray(proto?.[field]) ? (proto[field] as unknown[]) : []
  const out: { item: string; amount: number }[] = []
  for (const k of raw) {
    const e = (k ?? {}) as Record<string, unknown>
    if (typeof e.item === 'string' && typeof e.amount === 'number' && e.amount > 0) {
      out.push({ item: e.item, amount: Math.floor(e.amount) })
    }
  }
  return out
}

/** Fallback colour for a deposit terrain id (used only if the terrain prototype is missing). */
function depositFallbackColor(id: string): number {
  return FALLBACK_DEPOSITS.find((d) => d.id === id)?.color ?? 0x808080
}

/** Whether two rectangles overlap once each is grown outward by `margin` tiles. */
function overlaps(a: Rect, b: Rect, margin: number): boolean {
  return (
    a.x - margin < b.x + b.w &&
    a.x + a.w + margin > b.x &&
    a.y - margin < b.y + b.h &&
    a.y + a.h + margin > b.y
  )
}

/** Whether tile (x, y) falls inside any reserved rect once grown by {@link MARGIN} (keep-clear zone). */
function tileReserved(x: number, y: number, reserved: readonly Rect[]): boolean {
  const cell: Rect = { x, y, w: 1, h: 1 }
  for (let i = 0; i < reserved.length; i++) if (overlaps(cell, reserved[i]!, MARGIN)) return true
  return false
}

/**
 * Resolve a building prototype's `accepts` (a list of item ids) into stockpile slots, each capped
 * at the prototype's `storage`. Item colour is the resource identity, so each id is looked up via
 * `getProto` to read its colour. Returns an empty list for a building that stockpiles nothing.
 */
function acceptSlotsOf(
  getProto: (id: string) => SceneProto | undefined,
  proto: SceneProto | undefined,
): BuildingSlot[] {
  const accepts = proto?.accepts
  if (!Array.isArray(accepts)) return []
  const cap = typeof proto?.storage === 'number' ? proto.storage : 100
  const slots: BuildingSlot[] = []
  for (const id of accepts) {
    const item = getProto(String(id))
    // A store slot is both fillable (input ports) and drainable (output ports); it is not a
    // recipe slot, so its per-craft amount is 0.
    slots.push({
      color: typeof item?.color === 'number' ? item.color : 0xffffff,
      cap,
      role: ROLE_DEPOSIT | ROLE_DRAIN,
      amt: 0,
    })
  }
  return slots
}

/**
 * Parse a village prototype's `stages` into the sim's stage ladder: each stage's `demands`
 * (item id + `ratePerMin`) become {@link VillageDemand}s with the demanded item's colour and its
 * authored per-minute rate (honoured exactly by the sim's fractional accumulator, not pre-rounded).
 * Returns an empty ladder for a building with no stages.
 */
function villageStagesOf(
  getProto: (id: string) => SceneProto | undefined,
  proto: SceneProto | undefined,
): VillageStageConfig[] {
  const stages = proto?.stages
  if (!Array.isArray(stages)) return []
  return stages.map((raw): VillageStageConfig => {
    const s = (raw ?? {}) as Record<string, unknown>
    const demandsRaw = Array.isArray(s.demands) ? s.demands : []
    const demands = demandsRaw.map((d) => {
      const dem = (d ?? {}) as Record<string, unknown>
      const item = getProto(String(dem.item))
      return {
        color: typeof item?.color === 'number' ? item.color : 0xffffff,
        ratePerMin: typeof dem.ratePerMin === 'number' ? dem.ratePerMin : 0,
      }
    })
    return { population: typeof s.population === 'number' ? s.population : 0, demands }
  })
}

/**
 * Seed the credit balance with a scenario's starting `startingTreasury`: each authored
 * `{ item, amount }` line is valued at the item's price (item id → colour → price × amount) — the
 * same conversion a depot sale applies — so scenario data keeps its readable item terms while the
 * treasury holds one integer. Off the hot path (new-game only).
 */
function seedTreasury(
  getProto: (id: string) => SceneProto | undefined,
  treasury: TreasuryStore,
  prices: PriceTable,
  balance: readonly { item: string; amount: number }[],
): void {
  for (const entry of balance) {
    creditTreasury(
      treasury,
      entry.amount * priceOf(prices, colorOf(getProto(entry.item), 0xffffff)),
    )
  }
}

/**
 * Deposit each starting-kit entry into a building's matching stockpile slot (by resource colour),
 * capped at the slot. Used to grant the village a small grace buffer at spawn. Off the hot path.
 */
function grantStartingKit(
  getProto: (id: string) => SceneProto | undefined,
  store: BuildingStore,
  b: number,
  kit: readonly { item: string; amount: number }[],
): void {
  const n = store.slotN[b]!
  for (const entry of kit) {
    const color = colorOf(getProto(entry.item), 0xffffff)
    for (let k = 0; k < n; k++) {
      const i = b * MAX_SLOTS + k
      if (store.slotColor[i] !== color) continue
      const room = store.slotCap[i]! - store.slotCount[i]!
      store.slotCount[i] = store.slotCount[i]! + Math.max(0, Math.min(entry.amount, room))
      break
    }
  }
}

/**
 * Build the candidate deposit-cell anchors: a coarse grid of `cell`-sized cells around the origin,
 * kept within the scenario's spread band and clear of the reserved (village/orchard) rects. A
 * deposit patch placed anywhere inside a cell stays within that cell, so distinct cells never
 * overlap — no per-patch overlap test is needed. Deterministic (pure grid walk).
 */
function candidateCells(
  cell: number,
  spread: { min: number; max: number },
  reserved: Rect[],
): Rect[] {
  const cells: Rect[] = []
  const reach = Math.ceil(spread.max / cell) + 1
  for (let gy = -reach; gy <= reach; gy++) {
    for (let gx = -reach; gx <= reach; gx++) {
      const x = gx * cell
      const y = gy * cell
      const cheby = Math.max(Math.abs(x), Math.abs(y))
      if (cheby < spread.min || cheby > spread.max) continue
      const rect: Rect = { x, y, w: cell, h: cell }
      if (reserved.some((r) => overlaps(rect, r, MARGIN))) continue
      cells.push(rect)
    }
  }
  return cells
}

/** Deterministic in-place Fisher–Yates shuffle, drawing swaps from the world's seeded RNG. */
function shuffle<T>(api: ModApi, arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = api.randomInt(0, i)
    const tmp = arr[i]!
    arr[i] = arr[j]!
    arr[j] = tmp
  }
}

/** A tile coordinate the blob grower works in. */
interface Tile {
  readonly x: number
  readonly y: number
}

/** How many random seeds to try before giving up on placing a blob (deterministic bound). */
const SEED_TRIES = 40

/**
 * Grow an organic blob of up to `target` tiles by frontier random-walk from (sx, sy), drawing each
 * expansion step from the world's seeded RNG so the shape is varied yet reproducible. A tile joins
 * only if `canUse(x, y)` holds, and the result is a single 4-connected region — never a filled
 * rectangle. Runs once at new-game (off the hot path), so its working sets may allocate freely.
 * Returns the blob's tiles (empty if the seed itself is unusable).
 */
function growBlob(
  api: ModApi,
  sx: number,
  sy: number,
  target: number,
  canUse: (x: number, y: number) => boolean,
): Tile[] {
  const tiles: Tile[] = []
  if (target <= 0 || !canUse(sx, sy)) return tiles
  const seen = new Set<number>()
  const frontier: Tile[] = []
  const consider = (x: number, y: number): void => {
    const k = tileKey(x, y)
    if (seen.has(k)) return
    seen.add(k)
    frontier.push({ x, y })
  }
  consider(sx, sy)
  while (tiles.length < target && frontier.length > 0) {
    // Pop a random frontier tile (swap-with-last) so growth wanders rather than filling in order.
    const i = api.randomInt(0, frontier.length - 1)
    const cell = frontier[i]!
    frontier[i] = frontier[frontier.length - 1]!
    frontier.pop()
    if (!canUse(cell.x, cell.y)) continue
    tiles.push(cell)
    consider(cell.x + 1, cell.y)
    consider(cell.x - 1, cell.y)
    consider(cell.x, cell.y + 1)
    consider(cell.x, cell.y - 1)
  }
  return tiles
}

/**
 * Roll a usable blob seed within the world bounds via the seeded RNG: a tile passing `canUse`, and —
 * when a Chebyshev `band` is given (deposits keep to their spread ring) — within that distance of the
 * origin. Returns `null` after {@link SEED_TRIES} misses, so a crowded world just yields fewer patches.
 */
function findBlobSeed(
  api: ModApi,
  hx: number,
  hy: number,
  worldSize: WorldSize,
  band: Band | null,
  canUse: (x: number, y: number) => boolean,
): Tile | null {
  for (let t = 0; t < SEED_TRIES; t++) {
    const x = api.randomInt(-hx, worldSize.w - hx - 1)
    const y = api.randomInt(-hy, worldSize.h - hy - 1)
    if (band !== null) {
      const cheby = Math.max(Math.abs(x), Math.abs(y))
      if (cheby < band.min || cheby > band.max) continue
    }
    if (canUse(x, y)) return { x, y }
  }
  return null
}

/**
 * Spawn one settlement (a `village` prototype) anchored at (vx, vy): paint its footprint, register it
 * as a resource store so input ports can feed it, wire up its OWN stage ladder so it grows/declines
 * independently, and (for the origin spaceport) grant the scenario starting kit into its buffer. Emits
 * `base:spawn` so the host inspector names the tile. Returns the occupied footprint {@link Rect} so the
 * caller can keep later settlements/deposits clear of it. Off the hot path (new-game only).
 */
function placeVillage(
  api: ModApi,
  state: GameState,
  getProto: (id: string) => SceneProto | undefined,
  record: (protoId: string, x: number, y: number) => void,
  protoId: string,
  vx: number,
  vy: number,
  kit: readonly { item: string; amount: number }[],
): Rect {
  const proto = getProto(protoId)
  const vw = sizeDim(proto, 'w', 2)
  const vh = sizeDim(proto, 'h', 2)
  const eid = api.spawn({
    pos: { x: vx, y: vy },
    color: colorOf(proto, 0xb5651d),
    width: vw,
    height: vh,
  })
  record(protoId, vx, vy)
  // Register as a resource store so input ports can feed it (not a crafter: crafts = 0). Skipped if
  // the prototype stockpiles nothing.
  const slots = acceptSlotsOf(getProto, proto)
  if (slots.length > 0) {
    const b = registerBuilding(state.buildings, eid, vx, vy, vw, vh, 0, 1, slots)
    // Each settlement climbs its OWN demand ladder (a mining camp's shallow one, a spaceport's deep
    // one), so pass the parsed stages straight into the village entry.
    const stages = villageStagesOf(getProto, proto)
    if (stages.length > 0) registerVillage(state.villages, vx, vy, stages)
    if (kit.length > 0) grantStartingKit(getProto, state.buildings, b, kit)
  }
  return { x: vx, y: vy, w: vw, h: vh }
}

/**
 * Spawn the starting world for `config.scenario`: the origin spaceport (with the scenario's starting
 * kit), any extra settlements the scenario lists at increasing distance bands (each a distinct
 * `village` prototype with its own demand ladder — G3), an apple orchard, a procedural base-terrain
 * layer of organic biome blobs (water + cosmetic ground), and the scenario's resource deposits
 * scattered as organic patches — all sized/placed from the world's seeded RNG within the scenario's
 * bounded `worldSize`. Terrain tiles fill `state.terrain` (so the sim gates producer placement and
 * blocks building on water) and each village is registered in `state.buildings` as a resource store
 * (so input ports can feed it). Each spawn emits `base:spawn` for the host inspector. Deterministic
 * for a given seed + scenario.
 */
export function spawnScene(api: ModApi, state: GameState, config: SceneConfig = {}): void {
  const getProto = (id: string): SceneProto | undefined => api.getPrototype(id)
  const record = (protoId: string, x: number, y: number): void => {
    api.emit('base:spawn', { protoId, x, y })
  }
  const scenario = scenarioConfigOf(getProto, config.scenario ?? DEFAULT_SCENARIO)

  // New-game rule overrides + the opening treasury balance the player builds from.
  if (config.refundPermille !== undefined) {
    state.config.buildRefundPermille = Math.max(0, Math.floor(config.refundPermille))
  }
  seedTreasury(getProto, state.treasury, state.prices, scenario.startingTreasury)

  // Spaceport: a 2x2 block centered on the origin (top-left at -1,-1). It stays near spawn and gets
  // the scenario's starting kit as a grace buffer.
  const village = getProto('building.village')
  const vw = sizeDim(village, 'w', 2)
  const vh = sizeDim(village, 'h', 2)
  const vx = -Math.floor(vw / 2)
  const vy = -Math.floor(vh / 2)
  const orchard: Rect = { x: ORCHARD_X, y: ORCHARD_Y, w: ORCHARD_SIZE, h: ORCHARD_SIZE }
  // Reserved rects grow as we place things, so each later settlement/deposit stays clear of the
  // earlier ones (kept a MARGIN apart via `overlaps`). The starting kit lands in the spaceport only.
  const reserved: Rect[] = [
    placeVillage(api, state, getProto, record, 'building.village', vx, vy, scenario.startingKit),
    orchard,
  ]

  // Extra settlements (G3): a mining camp at mid distance, a research colony farther out — each a
  // distinct `village` prototype with its own shallow-to-deep demand ladder, so distance + different
  // needs make routing a puzzle. Each is dropped onto a candidate cell in its scenario distance band
  // (shuffled by the seeded RNG), kept clear of the spaceport/orchard/earlier settlements.
  const settlementCell = 2 + MARGIN // villages are 2x2; a cell holds one with a margin to spare.
  for (let s = 0; s < scenario.settlements.length; s++) {
    const settlement = scenario.settlements[s]!
    const cells = candidateCells(settlementCell, settlement.distance, reserved)
    shuffle(api, cells)
    if (cells.length === 0) continue // no clear ring cell in the band — skip this settlement.
    const cell = cells[0]!
    reserved.push(
      placeVillage(api, state, getProto, record, settlement.building, cell.x, cell.y, []),
    )
  }

  // Win goal (G5): resolve the scenario's target village to the tile we just placed it at, and
  // record it in the (serialized) config so a read-only selector can compare live vs. required
  // stage. Only the origin `building.village` is placed here, so a goal targeting anything else
  // simply doesn't arm (its village never spawned). Deterministic — pure config write, no RNG.
  if (scenario.goal !== null && scenario.goal.village === 'building.village') {
    state.config.goal = {
      village: scenario.goal.village,
      stage: scenario.goal.stage,
      vx,
      vy,
    }
  }

  // --- Procedural terrain: base biomes, then deposits on top ---------------------------------------
  //
  // Everything below is laid out as organic random-walk blobs within the scenario's bounded world,
  // drawn from the seeded RNG (so it varies per seed but is fully reproducible). A shared `occupied`
  // set of already-painted tiles keeps blobs from overlapping, and `canPaint` also excludes the
  // reserved spaceport/orchard/settlement rects. Painting a tile spawns its terrain entity, records
  // its type into `state.terrain`, and marks it occupied.
  const hx = Math.floor(scenario.worldSize.w / 2)
  const hy = Math.floor(scenario.worldSize.h / 2)
  const inBounds = (x: number, y: number): boolean =>
    x >= -hx && x < scenario.worldSize.w - hx && y >= -hy && y < scenario.worldSize.h - hy
  const occupied = new Set<number>()
  const canPaint = (x: number, y: number): boolean =>
    inBounds(x, y) && !occupied.has(tileKey(x, y)) && !tileReserved(x, y, reserved)
  const paint = (id: string, type: number, color: number, x: number, y: number): number => {
    const key = tileKey(x, y)
    const eid = api.spawn({ pos: { x, y }, sprite: TERRAIN_SPRITE, color, width: 1, height: 1 })
    state.terrain.set(key, type)
    occupied.add(key)
    record(id, x, y)
    return eid
  }

  // Base biomes (water + cosmetic ground): grow blobs of each biome until it covers roughly its
  // `coverage` permille of the world's tile area. Painted before deposits, so deposits never land on
  // water (or any biome) — they only claim the open default ground the biomes left behind.
  const worldArea = scenario.worldSize.w * scenario.worldSize.h
  for (let bi = 0; bi < scenario.biomes.length; bi++) {
    const biome = scenario.biomes[bi]!
    const proto = getProto(biome.terrain)
    const color = colorOf(proto, 0x808080)
    const type = terrainTypeOf(biome.terrain)
    const targetTiles = Math.floor((worldArea * biome.coverage) / 1000)
    let painted = 0
    // Cap the blob count so a pathological (tiny-blob, huge-coverage) config can't spin forever.
    const maxBlobs = Math.max(1, Math.ceil(targetTiles / Math.max(1, biome.size.min)) + 4)
    for (let n = 0; n < maxBlobs && painted < targetTiles; n++) {
      const seed = findBlobSeed(api, hx, hy, scenario.worldSize, null, canPaint)
      if (seed === null) break // world too crowded for another blob of this biome.
      const size = api.randomInt(biome.size.min, biome.size.max)
      const blob = growBlob(api, seed.x, seed.y, size, canPaint)
      for (let t = 0; t < blob.length; t++) {
        paint(biome.terrain, type, color, blob[t]!.x, blob[t]!.y)
        painted++
      }
    }
  }

  // Deposit patches: each deposit type scatters `frequency` organic blobs within its spread ring,
  // each of `patchSize` tiles. Finite scenarios roll a per-tile richness (and link the terrain entity
  // so exhaustion can grey it); an infinite scenario leaves the deposit maps empty (never depletes).
  const richness = scenario.richness
  for (let d = 0; d < scenario.deposits.length; d++) {
    const id = scenario.deposits[d]!
    const proto = getProto(id)
    const color = colorOf(proto, depositFallbackColor(id))
    const type = terrainTypeOf(id)
    const patches = api.randomInt(scenario.frequency.min, scenario.frequency.max)
    for (let p = 0; p < patches; p++) {
      const seed = findBlobSeed(api, hx, hy, scenario.worldSize, scenario.spread, canPaint)
      if (seed === null) continue // no clear spot in the spread ring — skip this patch.
      const size = api.randomInt(scenario.patch.min, scenario.patch.max)
      const blob = growBlob(api, seed.x, seed.y, size, canPaint)
      for (let t = 0; t < blob.length; t++) {
        const { x, y } = blob[t]!
        const eid = paint(id, type, color, x, y)
        if (richness !== null) {
          state.deposits.remaining.set(tileKey(x, y), api.randomInt(richness.min, richness.max))
          state.deposits.eid.set(tileKey(x, y), eid)
        }
      }
    }
  }

  // Apple orchard: a 6x6 square of 1x1 trees with its corner at (+50, +50).
  const tree = getProto('resource.apple_tree')
  const treeColor = colorOf(tree, 0x4caf50)
  for (let dy = 0; dy < ORCHARD_SIZE; dy++) {
    for (let dx = 0; dx < ORCHARD_SIZE; dx++) {
      const x = ORCHARD_X + dx
      const y = ORCHARD_Y + dy
      api.spawn({ pos: { x, y }, color: treeColor, width: 1, height: 1 })
      record('resource.apple_tree', x, y)
    }
  }
}
