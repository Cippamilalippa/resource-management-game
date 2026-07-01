import {
  createGameWorld,
  Scheduler,
  counterSystem,
  type GameWorld,
  type System,
} from '@factory/engine/core'
import { PrototypeRegistry } from '@factory/engine/data'
import {
  runModScripts,
  type DiscoveredMod,
  type FileSource,
  type ScriptModule,
  type ScriptResolver,
} from '@factory/engine/modloader'
import type { DiscoveredModInfo } from '../electron/preload.ts'
import { validateContent, type GameState } from './gameLogic.ts'
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
 * Mod scripts pre-bundled into the renderer at build time. The renderer has no disk
 * access, so an arbitrary mod-script path cannot be dynamically imported the way the
 * headless runner does it (`apps/headless/bootstrap.ts`); instead Vite statically
 * globs every base-mod script into the bundle here, and the resolver below maps a
 * manifest's script path to its matching pre-bundled module. (Third-party mods that
 * are not part of this build are therefore out of scope — see `resolveBundledScript`.)
 */
const bundledScripts = import.meta.glob('../../../mods/*/scripts/**/*.ts')

/**
 * Find the bundled-script glob key for a mod directory + manifest-relative script path.
 * Glob keys look like `../../../mods/<dir>/scripts/main.ts`; a manifest path is relative
 * to its mod root (e.g. `scripts/main.ts`), so the matching key is the one ending in
 * `/<dir>/<path>`. The leading slash anchors the directory so `base` never matches
 * `database`. Pure (no `import.meta`) so it can be unit-tested.
 */
export function matchScriptKey(
  keys: readonly string[],
  dir: string,
  path: string,
): string | undefined {
  const suffix = `/${dir}/${path}`
  return keys.find((k) => k.endsWith(suffix))
}

/**
 * A renderer-side {@link FileSource} that carries only its mod's directory id. The
 * renderer cannot read files (no fs), and {@link runModScripts} never reads off the
 * source — it only passes it to the resolver — so `readText`/`exists` are inert. The
 * `modDir` is what {@link resolveBundledScript} uses to find the pre-bundled module.
 */
class BundledModSource implements FileSource {
  constructor(readonly modDir: string) {}
  readText(): Promise<string> {
    return Promise.reject(new Error('renderer mod source has no file access'))
  }
  exists(): Promise<boolean> {
    return Promise.resolve(false)
  }
}

/**
 * The Electron/renderer {@link ScriptResolver}: turn a mod's script path into the module
 * Vite pre-bundled for it. The headless host dynamic-imports the `.ts` off disk; here we
 * look it up in {@link bundledScripts} instead, through the SAME engine seam — the engine
 * stays agnostic of how a path becomes a module. A path with no bundled match (e.g. an
 * unbundled third-party mod) fails loud, matching bad content elsewhere.
 */
const resolveBundledScript: ScriptResolver = async (source, path): Promise<ScriptModule> => {
  const dir = (source as BundledModSource).modDir
  const key = matchScriptKey(Object.keys(bundledScripts), dir, path)
  if (!key) {
    throw new Error(`No bundled script for "${dir}/${path}" (only base-mod scripts are bundled)`)
  }
  return (await bundledScripts[key]!()) as ScriptModule
}

/**
 * Build the renderer-side sim from the prototypes the main process loaded through
 * the mod loader. Spawns the same starting scene the headless runner uses, then runs
 * each mod's scripts against the live world through the SAME `runModScripts` path as
 * `apps/headless/bootstrap.ts` — collecting the systems they contribute and scheduling
 * them after the base systems, in identical order, so both views stay byte-for-byte
 * consistent.
 */
export async function createSim(
  prototypes: readonly ClientPrototype[],
  discovered: readonly DiscoveredModInfo[] = [],
  seed = 1,
): Promise<ClientSim> {
  const world = createGameWorld(seed)

  const byId = new Map(prototypes.map((p) => [p.id, p]))
  const registry = new InspectRegistry()

  // The base mod owns the game state and spawns the scene; subscribe before running it.
  // `base:ready` hands us the read handle (render interpolation, inspector, placement
  // ghosts); `base:spawn` lets us name each scene tile for the read-only inspector from the
  // prototypes we already hold — a non-sim side effect that never mutates the world.
  let state: GameState | undefined
  world.events.on('base:ready', (s) => {
    state = s as GameState
  })
  world.events.on('base:spawn', (payload) => {
    const { protoId, x, y } = payload as { protoId: string; x: number; y: number }
    const proto = byId.get(protoId)
    const name = typeof proto?.name === 'string' ? proto.name : protoId
    const type = typeof proto?.type === 'string' ? proto.type : 'building'
    registry.record(x, y, {
      name,
      type,
      ...(typeof proto?.info === 'string' ? { detail: proto.info } : {}),
    })
  })

  // Run mod scripts against the live world, mirroring apps/headless/bootstrap.ts. The
  // ModApi host needs a PrototypeRegistry; rebuild one from the prototypes the main
  // process already loaded (same loose schema → round-trips cleanly). The renderer has
  // no fs, so each reconstructed source carries only its directory id for the resolver.
  const hostRegistry = new PrototypeRegistry()
  for (const p of prototypes) hostRegistry.register(p)
  // Assert the recipe/tech/crafter/village content is well-formed before running anything.
  validateContent(hostRegistry)
  const mods: DiscoveredMod[] = discovered.map((d) => ({
    manifest: d.manifest,
    source: new BundledModSource(d.dir),
  }))
  const modSystems: System[] = []
  await runModScripts(
    mods,
    { registry: hostRegistry, world, addSystem: (s) => modSystems.push(s) },
    resolveBundledScript,
  )
  if (!state) throw new Error('base mod did not publish game state (base:ready)')

  const scheduler = new Scheduler([counterSystem, ...modSystems])
  return { world, scheduler, state, registry }
}
