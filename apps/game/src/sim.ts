import { createGameWorld, Scheduler, counterSystem, type GameWorld } from '@factory/engine/core'
import { createGameState, createGameSystems, type GameState } from './gameLogic.ts'
import { spawnScene } from './scene.ts'
import { InspectRegistry } from './inspect.ts'

/** A prototype as delivered by the preload bridge. */
export interface ClientPrototype {
  id: string
  type: string
  [key: string]: unknown
}

export interface ClientSim {
  world: GameWorld
  scheduler: Scheduler
  /** Base-game state (belt grid, …); the render loop reads it for move-cycle interpolation. */
  state: GameState
  /** Tile→name memory for the read-only inspector, pre-seeded with the starting scene. */
  registry: InspectRegistry
}

/**
 * Build the renderer-side sim from the prototypes the main process loaded through
 * the mod loader. Spawns the same starting scene the headless runner uses, so both
 * views stay consistent.
 */
export function createSim(prototypes: readonly ClientPrototype[], seed = 1): ClientSim {
  const world = createGameWorld(seed)

  const byId = new Map(prototypes.map((p) => [p.id, p]))
  const registry = new InspectRegistry()
  // Record each scene object's prototype name/type at its top-left tile so the inspector
  // can name the starting village and orchard (a read-only, non-sim side effect).
  spawnScene(
    world,
    (id) => byId.get(id),
    (eid, protoId) => {
      const proto = byId.get(protoId)
      const name = typeof proto?.name === 'string' ? proto.name : protoId
      const type = typeof proto?.type === 'string' ? proto.type : 'building'
      const { Position } = world.components
      registry.record(Position.x[eid]!, Position.y[eid]!, { name, type })
    },
  )

  const state = createGameState()
  const scheduler = new Scheduler([counterSystem, ...createGameSystems(state)])
  return { world, scheduler, state, registry }
}
