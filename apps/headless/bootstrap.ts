import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { createGameWorld, Scheduler, counterSystem, type GameWorld } from '@factory/engine/core'
import { PrototypeRegistry, type Prototype } from '@factory/engine/data'
import { discoverModSources, discoverAndLoad, type LoadResult } from '@factory/engine/modloader'
import { createGameState, createGameSystems, type GameState } from './gameLogic.ts'
import { spawnScene } from './scene.ts'

/** Absolute path to the repo's /mods directory (the base game lives in mods/base). */
export function modsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return resolve(here, '../../mods')
}

export interface Sim {
  readonly world: GameWorld
  readonly registry: PrototypeRegistry
  readonly scheduler: Scheduler
  readonly load: LoadResult
  /** Mutable base-game state (placed belts, …). */
  readonly state: GameState
}

/**
 * Build a fully wired sim from a seed: discover every mod in /mods (the base game
 * is mods/base) and load them through the mod loader, create a deterministic
 * world, and spawn the starting scene (a central village plus an apple orchard).
 * Shared by the headless runner and the tests.
 */
export async function bootstrapSim(seed: number, tickRate = 60): Promise<Sim> {
  const registry = new PrototypeRegistry()
  const sources = await discoverModSources(modsDir())
  const load = await discoverAndLoad(sources, registry)

  const world = createGameWorld(seed)
  spawnScene(world, (id): Prototype | undefined => registry.get(id))

  const state = createGameState()
  const scheduler = new Scheduler([counterSystem, ...createGameSystems(state)], { tickRate })
  return { world, registry, scheduler, load, state }
}
