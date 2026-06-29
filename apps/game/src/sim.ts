import { createGameWorld, Scheduler, counterSystem, type GameWorld } from '@factory/engine/core'
import { createGameState, createGameSystems, type GameState } from './gameLogic.ts'
import { spawnScene } from './scene.ts'

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
}

/**
 * Build the renderer-side sim from the prototypes the main process loaded through
 * the mod loader. Spawns the same starting scene the headless runner uses, so both
 * views stay consistent.
 */
export function createSim(prototypes: readonly ClientPrototype[], seed = 1): ClientSim {
  const world = createGameWorld(seed)

  const byId = new Map(prototypes.map((p) => [p.id, p]))
  spawnScene(world, (id) => byId.get(id))

  const state = createGameState()
  const scheduler = new Scheduler([counterSystem, ...createGameSystems(state)])
  return { world, scheduler, state }
}
