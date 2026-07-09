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
import { serialize, type WorldSnapshot } from '@factory/engine/persistence'
import type { BaseReady } from '../../mods/base/scripts/main.ts'
import {
  validateContent,
  itemColorPrices,
  blockingTerrainIds,
  serializeGameState,
  type GameState,
} from './gameLogic.ts'

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
  /** Snapshot the whole sim (engine entities + the base mod's out-of-ECS state) for a save. */
  serialize(): WorldSnapshot
  /**
   * Restore a saved snapshot in place: fast-forward the world clock/RNG and rebuild the base
   * mod's stores + entities. Meant for a sim bootstrapped with `startScene: false` (an empty
   * origin), matching how a real load starts before any scene exists.
   */
  restore(snapshot: WorldSnapshot): void
}

/** Options for {@link bootstrapSim}. */
export interface BootstrapOptions {
  readonly tickRate?: number
  /**
   * Spawn the clean starting scene (default). Pass `false` to leave the world empty — the
   * origin a save is loaded into (see {@link Sim.restore}), so a load never doubles the scene.
   */
  readonly startScene?: boolean
  /**
   * Which starting scenario to lay out (a `scenario.*` id). Omitted → the base mod's default
   * scenario. Only consulted when `startScene` is true.
   */
  readonly scenario?: string
}

/**
 * Build a fully wired sim from a seed: discover every mod in /mods (the base game
 * is mods/base) and load them through the mod loader, create a deterministic
 * world, then run the mods. The base mod owns the game state and registers the base
 * systems through the `ModApi` — there is no app-side game logic here. It publishes
 * `base:ready` with the live state plus new-game/load closures; the host picks the
 * world's origin (a fresh scene by default, or nothing when `startScene: false`).
 * Shared by the headless runner and the tests.
 */
export async function bootstrapSim(
  seed: number,
  { tickRate = 60, startScene = true, scenario }: BootstrapOptions = {},
): Promise<Sim> {
  const registry = new PrototypeRegistry()
  const sources = await discoverModSources(modsDir())
  const discovered: DiscoveredMod[] = await Promise.all(sources.map(readManifest))
  // Prototypes load first — scripts need the world, which does not exist yet.
  const load = await loadMods(discovered, registry)
  // With every prototype registered, assert the recipe/tech/crafter/village content is
  // well-formed (shapes, references, acyclic graphs) before anything runs. Bad content fails loud.
  validateContent(registry)

  const world = createGameWorld(seed)
  // The base mod publishes its read handle plus the origin closures; subscribe before running it,
  // then pick the world's origin — a clean scene, or nothing (loaded later via `restore`).
  let ready: BaseReady | undefined
  world.events.on('base:ready', (r) => {
    ready = r as BaseReady
  })

  // Run mod scripts against the live world. The base mod contributes its systems here,
  // collected in order and scheduled after the engine's counter.
  const modSystems: System[] = []
  await runModScripts(
    discovered,
    { registry, world, addSystem: (s) => modSystems.push(s) },
    importScript,
  )
  if (!ready) throw new Error('base mod did not publish game state (base:ready)')
  // Hand the sim the colour→credit price table computed from the recipe DAG BEFORE any origin is
  // applied: the scene seeds its starting balance through it, and a legacy save converts through it.
  ready.setPrices(itemColorPrices(registry))
  // Likewise the impassable-terrain rule (water) — derived from content, re-supplied each origin.
  ready.setBlockingTerrain(blockingTerrainIds(registry))
  if (startScene) ready.newGame(scenario === undefined ? undefined : { scenario })

  const state = ready.state
  const scheduler = new Scheduler([counterSystem, ...modSystems], { tickRate })
  return {
    world,
    registry,
    scheduler,
    load,
    state,
    serialize: () => serialize(world, { base: serializeGameState(state) }),
    restore: (snapshot) => {
      // Fast-forward the engine clock/RNG (the hash covers both), then hand the mod its state.
      world.tick = snapshot.tick
      world.rng.setState(snapshot.rngState)
      ready!.load(snapshot)
    },
  }
}
