import { spawnEntity, type GameWorld } from '@factory/engine/core'
import {
  tileKey,
  terrainTypeOf,
  registerBuilding,
  TERRAIN_SPRITE,
  type TerrainGrid,
  type BuildingStore,
  type AcceptSlot,
} from './gameLogic.ts'

/**
 * The starting scene for the base game. Kept identical to the headless copy
 * (`apps/headless/scene.ts`) so the on-screen world and the headless run match.
 *
 * Layout (integer tile grid; the renderer centers the camera on the origin):
 *   - one 2x2 "village" centered on the origin,
 *   - a 6x6 orchard of apple trees with its corner at (+50, +50), and
 *   - four terrain patches (fertile soil, forest, iron + copper deposits) that gate which
 *     resource producers can be built on top of them.
 *
 * Reads color/size from the loaded prototypes when present, falling back to sane
 * defaults so the scene still builds if a prototype is missing. Pure setup work
 * (runs once at boot) — no RNG, so the scene is fully deterministic.
 */

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
 * patches resource producers are built on. The optional `onSpawn(eid, protoId)` is a
 * non-sim hook the app uses to record each spawned object's prototype for the read-only UI
 * inspector; the headless runner omits it. The optional `terrain` grid, when given, is
 * populated with each terrain tile's type so the sim can gate producer placement.
 */
export function spawnScene(
  gw: GameWorld,
  getProto: (id: string) => SceneProto | undefined,
  onSpawn?: (eid: number, protoId: string) => void,
  terrain?: TerrainGrid,
  buildings?: BuildingStore,
): void {
  // Village: a 2x2 block centered on the origin (top-left at -1,-1).
  const village = getProto('building.village')
  const vw = sizeDim(village, 'w', 2)
  const vh = sizeDim(village, 'h', 2)
  const vx = -Math.floor(vw / 2)
  const vy = -Math.floor(vh / 2)
  const villageEid = spawnEntity(gw, {
    pos: { x: vx, y: vy },
    color: colorOf(village, 0xb5651d),
    width: vw,
    height: vh,
  })
  onSpawn?.(villageEid, 'building.village')
  // Register the village as a resource store so input ports can feed it (a non-producer:
  // prodColor NONE = -1). Skipped when no store is provided (e.g. a minimal headless boot).
  if (buildings) {
    const slots = acceptSlotsOf(getProto, village)
    if (slots.length > 0) registerBuilding(buildings, villageEid, vx, vy, vw, vh, -1, 1, slots)
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
        const eid = spawnEntity(gw, {
          pos: { x, y },
          sprite: TERRAIN_SPRITE,
          color,
          width: 1,
          height: 1,
        })
        terrain?.set(tileKey(x, y), type)
        onSpawn?.(eid, patch.id)
      }
    }
  }

  // Apple orchard: a 6x6 square of 1x1 trees with its corner at (+50, +50).
  const tree = getProto('resource.apple_tree')
  const treeColor = colorOf(tree, 0x4caf50)
  for (let dy = 0; dy < ORCHARD_SIZE; dy++) {
    for (let dx = 0; dx < ORCHARD_SIZE; dx++) {
      const treeEid = spawnEntity(gw, {
        pos: { x: ORCHARD_X + dx, y: ORCHARD_Y + dy },
        color: treeColor,
        width: 1,
        height: 1,
      })
      onSpawn?.(treeEid, 'resource.apple_tree')
    }
  }
}
