/**
 * The starting scene for the base game ("mod zero"). Spawns the clean starting world through
 * the stable {@link ModApi} — the same surface a third-party mod gets — and populates the
 * mod-owned {@link GameState} (terrain + building store) the systems read.
 *
 * Layout (integer tile grid; the renderer centers the camera on the origin):
 *   - one 2x2 "village" centered on the origin,
 *   - a 6x6 orchard of apple trees with its corner at (+50, +50), and
 *   - six terrain patches (bauxite, silica, coal, titanium, rare-earth, oil deposits) that gate
 *     which resource producers can be built on top of them.
 *
 * Reads color/size from the loaded prototypes when present, falling back to sane defaults so
 * the scene still builds if a prototype is missing. Pure setup work (runs once at init) — no
 * RNG, so the scene is fully deterministic.
 *
 * For every object it spawns, it emits a `base:spawn` event carrying the prototype id and
 * anchor tile. The host (the renderer) uses this — read-only — to name tiles for the
 * inspector; the headless runner has no listener, so it is a no-op there. This keeps the
 * sim→render flow one-way: the scene never knows about the UI.
 */
import type { ModApi } from '@factory/engine/scripting'
import {
  tileKey,
  terrainTypeOf,
  registerBuilding,
  registerVillage,
  villageDemandNeed,
  TERRAIN_SPRITE,
  ROLE_DEPOSIT,
  ROLE_DRAIN,
  type BuildingSlot,
  type GameState,
  type VillageStageConfig,
} from './sim.ts'

/** The prototype shape this scene reads (only `color` and `size` are consulted). */
export type SceneProto = Record<string, unknown>

/** Where the apple orchard's corner sits, and how many tiles on a side. */
const ORCHARD_X = 50
const ORCHARD_Y = 50
const ORCHARD_SIZE = 6

/**
 * The natural terrain patches dotted around the village. Each is a rectangle of a single
 * terrain prototype; producers that declare a matching `requiresTerrain` can only be built
 * on top of these tiles. Kept clear of the village (−1..0) and the orchard (50..55).
 */
const TERRAIN_PATCHES: ReadonlyArray<{
  id: string
  x: number
  y: number
  w: number
  h: number
  fallback: number
}> = [
  { id: 'terrain.bauxite_deposit', x: 8, y: -3, w: 4, h: 4, fallback: 0xb08d57 },
  { id: 'terrain.silica_quarry', x: 8, y: 4, w: 4, h: 4, fallback: 0xe8d9a0 },
  { id: 'terrain.coal_seam', x: 8, y: 11, w: 4, h: 4, fallback: 0x3c3c44 },
  { id: 'terrain.titanium_deposit', x: -13, y: -3, w: 4, h: 4, fallback: 0x9aa7b0 },
  { id: 'terrain.rare_earth_deposit', x: -13, y: 4, w: 4, h: 4, fallback: 0xa86fb8 },
  { id: 'terrain.oil_field', x: -13, y: 11, w: 4, h: 4, fallback: 0x2a2a38 },
]

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

/**
 * Resolve a building prototype's `accepts` (a list of item ids) into stockpile slots, each
 * capped at the prototype's `storage`. Item colour is the resource identity, so each id is
 * looked up via `getProto` to read its colour. Returns an empty list for a building that
 * stockpiles nothing (e.g. plain scenery).
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
 * (item id + `ratePerMin`) become {@link VillageDemand}s with the demanded item's colour and the
 * integer per-cadence amount. Returns an empty ladder for a building with no stages.
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
        need: villageDemandNeed(typeof dem.ratePerMin === 'number' ? dem.ratePerMin : 0),
      }
    })
    return { population: typeof s.population === 'number' ? s.population : 0, demands }
  })
}

/**
 * Spawn the clean starting world: a central village, an apple orchard, and the terrain
 * patches resource producers are built on. Terrain tiles fill `state.terrain` (so the sim
 * gates producer placement) and the village is registered in `state.buildings` as a resource
 * store (so input ports can feed it). Each spawn emits `base:spawn` for the host inspector.
 */
export function spawnScene(api: ModApi, state: GameState): void {
  const getProto = (id: string): SceneProto | undefined => api.getPrototype(id)
  const record = (protoId: string, x: number, y: number): void => {
    api.emit('base:spawn', { protoId, x, y })
  }

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
    registerBuilding(state.buildings, villageEid, vx, vy, vw, vh, 0, 1, slots)
    // Wire up the village demand ladder so it grows/declines on how well it is supplied. All
    // base villages share the one prototype's stages.
    const stages = villageStagesOf(getProto, village)
    if (stages.length > 0) {
      state.villages.stages = stages
      registerVillage(state.villages, vx, vy)
    }
  }

  // Terrain patches: a flat, full-tile fill recorded into the terrain grid (so producer
  // placement can read it). Spawned before the orchard/belts/producers that sit on top.
  for (const patch of TERRAIN_PATCHES) {
    const proto = getProto(patch.id)
    const color = colorOf(proto, patch.fallback)
    const type = terrainTypeOf(patch.id)
    for (let dy = 0; dy < patch.h; dy++) {
      for (let dx = 0; dx < patch.w; dx++) {
        const x = patch.x + dx
        const y = patch.y + dy
        api.spawn({
          pos: { x, y },
          sprite: TERRAIN_SPRITE,
          color,
          width: 1,
          height: 1,
        })
        state.terrain.set(tileKey(x, y), type)
        record(patch.id, x, y)
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
