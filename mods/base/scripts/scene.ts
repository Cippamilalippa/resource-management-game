/**
 * The starting scene for the base game ("mod zero"). Spawns the clean starting world through
 * the stable {@link ModApi} — the same surface a third-party mod gets — and populates the
 * mod-owned {@link GameState} (terrain + building store) the systems read.
 *
 * Layout (integer tile grid; the renderer centers the camera on the origin):
 *   - one 2x2 "village" centered on the origin,
 *   - a 6x6 orchard of apple trees with its corner at (+50, +50), and
 *   - four terrain patches (fertile soil, forest, iron + copper deposits) that gate which
 *     resource producers can be built on top of them.
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
  TERRAIN_SPRITE,
  type AcceptSlot,
  type GameState,
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
  { id: 'terrain.fertile_soil', x: 8, y: -3, w: 5, h: 5, fallback: 0xc8e6a0 },
  { id: 'terrain.forest', x: 8, y: 6, w: 5, h: 5, fallback: 0xa5c88a },
  { id: 'terrain.iron_deposit', x: -13, y: -3, w: 4, h: 4, fallback: 0xcbd2da },
  { id: 'terrain.copper_deposit', x: -13, y: 6, w: 4, h: 4, fallback: 0xe2b48c },
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
): AcceptSlot[] {
  const accepts = proto?.accepts
  if (!Array.isArray(accepts)) return []
  const cap = typeof proto?.storage === 'number' ? proto.storage : 100
  const slots: AcceptSlot[] = []
  for (const id of accepts) {
    const item = getProto(String(id))
    slots.push({ color: typeof item?.color === 'number' ? item.color : 0xffffff, cap })
  }
  return slots
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
  // Register the village as a resource store so input ports can feed it (a non-producer:
  // prodColor NONE = -1). Skipped if the prototype stockpiles nothing.
  const slots = acceptSlotsOf(getProto, village)
  if (slots.length > 0) registerBuilding(state.buildings, villageEid, vx, vy, vw, vh, -1, 1, slots)

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
