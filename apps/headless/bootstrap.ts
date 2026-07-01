import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  createGameWorld,
  Scheduler,
  counterSystem,
  type GameWorld,
  type System,
} from '@factory/engine/core'
import { PrototypeRegistry } from '@factory/engine/data'
import {
  readManifest,
  loadMods,
  runModScripts,
  type DiscoveredMod,
  type LoadResult,
  type ScriptModule,
  type ScriptResolver,
} from '@factory/engine/modloader'
import { discoverModSources, NodeFileSource } from '@factory/engine/modloader/node'
import { validateContent, type GameState } from './gameLogic.ts'

/**
 * Resolve a mod script to a module by dynamically importing it. Runs under tsx, so
 * `.ts` scripts import directly; the absolute path goes through `pathToFileURL` so
 * dynamic import is correct across platforms. (Electron/renderer will supply their
 * own resolver when those hosts are wired up.)
 */
const importScript: ScriptResolver = async (source, path): Promise<ScriptModule> => {
  if (!(source instanceof NodeFileSource)) {
    throw new Error('headless script resolver requires a NodeFileSource')
  }
  return (await import(pathToFileURL(resolve(source.root, path)).href)) as ScriptModule
}

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
  /** Mutable base-game state (placed belts, …), owned by mods/base and published via `base:ready`. */
  readonly state: GameState
}

/**
 * Build a fully wired sim from a seed: discover every mod in /mods (the base game
 * is mods/base) and load them through the mod loader, create a deterministic
 * world, then run the mods. The base mod owns the game state, spawns the starting
 * scene and registers the base systems through the `ModApi` — there is no app-side
 * game logic here. We capture the state the base mod publishes (`base:ready`) for
 * the runner/tests. Shared by the headless runner and the tests.
 */
export async function bootstrapSim(seed: number, tickRate = 60): Promise<Sim> {
  const registry = new PrototypeRegistry()
  const sources = await discoverModSources(modsDir())
  const discovered: DiscoveredMod[] = await Promise.all(sources.map(readManifest))
  // Prototypes load first — scripts need the world, which does not exist yet.
  const load = await loadMods(discovered, registry)
  // With every prototype registered, assert the recipe/tech/crafter/village content is
  // well-formed (shapes, references, acyclic graphs) before anything runs. Bad content fails loud.
  validateContent(registry)

  const world = createGameWorld(seed)
  // The base mod publishes its read handle to the live game state; subscribe before running it.
  let state: GameState | undefined
  world.events.on('base:ready', (s) => {
    state = s as GameState
  })

  // Run mod scripts against the live world. The base mod spawns the scene and contributes
  // its systems here, collected in order and scheduled after the engine's counter.
  const modSystems: System[] = []
  await runModScripts(
    discovered,
    { registry, world, addSystem: (s) => modSystems.push(s) },
    importScript,
  )
  if (!state) throw new Error('base mod did not publish game state (base:ready)')

  const scheduler = new Scheduler([counterSystem, ...modSystems], { tickRate })
  return { world, registry, scheduler, load, state }
}
