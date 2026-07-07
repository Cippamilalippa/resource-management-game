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
  depositTreasury,
  MAX_SLOTS,
  TERRAIN_SPRITE,
  ROLE_DEPOSIT,
  ROLE_DRAIN,
  type BuildingSlot,
  type BuildingStore,
  type GameState,
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

/** A scenario's parsed win goal: reach `village`'s 0-based `stage`. `null` when none is authored. */
type GoalConfig = { readonly village: string; readonly stage: number } | null

/** The scenario layout params the scene consumes, after parsing (with fallbacks). */
interface ScenarioConfig {
  readonly deposits: readonly string[]
  readonly patch: { readonly min: number; readonly max: number }
  readonly spread: { readonly min: number; readonly max: number }
  readonly startingKit: readonly { readonly item: string; readonly amount: number }[]
  readonly startingTreasury: readonly { readonly item: string; readonly amount: number }[]
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
    patch: rangeOf(proto, 'patchSize', 4, 5),
    spread: rangeOf(proto, 'spread', 6, 18),
    startingKit: flowListOf(proto, 'startingKit'),
    startingTreasury: flowListOf(proto, 'startingTreasury'),
    goal: goalOf(proto),
  }
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
 * Deposit each starting-kit entry into a building's matching stockpile slot (by resource colour),
 * capped at the slot. Used to grant the village a small grace buffer at spawn. Off the hot path.
 */
/**
 * Seed the global build-cost treasury with a scenario's starting balance (item id → colour →
 * banked amount). This is the player's opening stock — what they can build before any depot has
 * refilled the pool. Off the hot path (new-game only).
 */
function seedTreasury(
  getProto: (id: string) => SceneProto | undefined,
  treasury: TreasuryStore,
  balance: readonly { item: string; amount: number }[],
): void {
  for (const entry of balance) {
    depositTreasury(treasury, colorOf(getProto(entry.item), 0xffffff), entry.amount)
  }
}

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

/**
 * Spawn the starting world for `config.scenario`: a central village (with the scenario's starting
 * kit), an apple orchard, and the scenario's resource deposits scattered as terrain patches whose
 * positions/sizes are drawn from the world's seeded RNG within the scenario's bands. Terrain tiles
 * fill `state.terrain` (so the sim gates producer placement) and the village is registered in
 * `state.buildings` as a resource store (so input ports can feed it). Each spawn emits `base:spawn`
 * for the host inspector. Deterministic for a given seed + scenario.
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
  seedTreasury(getProto, state.treasury, scenario.startingTreasury)

  // Village: a 2x2 block centered on the origin (top-left at -1,-1).
  const village = getProto('building.village')
  const vw = sizeDim(village, 'w', 2)
  const vh = sizeDim(village, 'h', 2)
  const vx = -Math.floor(vw / 2)
  const vy = -Math.floor(vh / 2)
  const villageEid = api.spawn({
    pos: { x: vx, y: vy },
    color: colorOf(village, 0xb5651d),
    width: vw,
    height: vh,
  })
  record('building.village', vx, vy)
  // Register the village as a resource store so input ports can feed it (not a crafter:
  // crafts = 0). Skipped if the prototype stockpiles nothing.
  const slots = acceptSlotsOf(getProto, village)
  if (slots.length > 0) {
    const villageB = registerBuilding(state.buildings, villageEid, vx, vy, vw, vh, 0, 1, slots)
    // Wire up the village demand ladder so it grows/declines on how well it is supplied. All
    // base villages share the one prototype's stages.
    const stages = villageStagesOf(getProto, village)
    if (stages.length > 0) {
      state.villages.stages = stages
      registerVillage(state.villages, vx, vy)
    }
    // Grant the scenario's starting kit into the village buffer (a grace stock at spawn).
    grantStartingKit(getProto, state.buildings, villageB, scenario.startingKit)
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

  // Deposit patches: scatter each scenario deposit onto a distinct candidate cell (shuffled by the
  // seeded RNG), sizing and jittering the patch inside its cell. Cells are disjoint, so patches
  // never overlap; the village/orchard rects are excluded up-front.
  const orchard: Rect = { x: ORCHARD_X, y: ORCHARD_Y, w: ORCHARD_SIZE, h: ORCHARD_SIZE }
  const villageRect: Rect = { x: vx, y: vy, w: vw, h: vh }
  const cellSize = scenario.patch.max + MARGIN
  const cells = candidateCells(cellSize, scenario.spread, [villageRect, orchard])
  shuffle(api, cells)

  for (let d = 0; d < scenario.deposits.length && d < cells.length; d++) {
    const id = scenario.deposits[d]!
    const proto = getProto(id)
    const color = colorOf(proto, depositFallbackColor(id))
    const type = terrainTypeOf(id)
    const cellRect = cells[d]!
    const size = api.randomInt(scenario.patch.min, scenario.patch.max)
    // Jitter within the cell's free space so the patch still fits entirely inside its own cell.
    const ox = api.randomInt(0, cellSize - size)
    const oy = api.randomInt(0, cellSize - size)
    const px = cellRect.x + ox
    const py = cellRect.y + oy
    for (let dy = 0; dy < size; dy++) {
      for (let dx = 0; dx < size; dx++) {
        const x = px + dx
        const y = py + dy
        api.spawn({ pos: { x, y }, sprite: TERRAIN_SPRITE, color, width: 1, height: 1 })
        state.terrain.set(tileKey(x, y), type)
        record(id, x, y)
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
