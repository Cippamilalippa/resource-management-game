import { spawnEntity, type GameWorld } from '@factory/engine/core'

/**
 * The starting scene for the base game. Kept identical to the renderer-side copy
 * (`apps/game/src/scene.ts`) so the headless run and the on-screen world match.
 *
 * Layout (integer tile grid; the renderer centers the camera on the origin):
 *   - one 2x2 "village" centered on the origin, and
 *   - a 6x6 orchard of apple trees with its corner at (+50, +50).
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
 * Spawn the clean starting world: a central village plus an apple orchard. The optional
 * `onSpawn(eid, protoId)` is a non-sim hook the app uses to record each spawned object's
 * prototype for the read-only UI inspector; the headless runner omits it.
 */
export function spawnScene(
  gw: GameWorld,
  getProto: (id: string) => SceneProto | undefined,
  onSpawn?: (eid: number, protoId: string) => void,
): void {
  // Village: a 2x2 block centered on the origin (top-left at -1,-1).
  const village = getProto('building.village')
  const vw = sizeDim(village, 'w', 2)
  const vh = sizeDim(village, 'h', 2)
  const villageEid = spawnEntity(gw, {
    pos: { x: -Math.floor(vw / 2), y: -Math.floor(vh / 2) },
    color: colorOf(village, 0xb5651d),
    width: vw,
    height: vh,
  })
  onSpawn?.(villageEid, 'building.village')

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
