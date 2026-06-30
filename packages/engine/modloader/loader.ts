import type { PrototypeRegistry } from '../data/index.ts'
import { createModApi, type ModApi, type ModApiHost } from '../scripting/index.ts'
import type { FileSource } from './fileSource.ts'
import { modManifestSchema, type ModManifest } from './manifest.ts'

/** A mod that has been located and had its manifest validated, not yet merged. */
export interface DiscoveredMod {
  readonly manifest: ModManifest
  readonly source: FileSource
}

/** Result of a load pass. */
export interface LoadResult {
  /** Manifests in the order they were applied. */
  readonly order: readonly ModManifest[]
  /** Total prototypes registered across all mods. */
  readonly prototypeCount: number
}

/** Read and validate the `manifest.json` at the root of a file source. */
export async function readManifest(source: FileSource): Promise<DiscoveredMod> {
  const text = await source.readText('manifest.json')
  const parsed: unknown = JSON.parse(text)
  const result = modManifestSchema.safeParse(parsed)
  if (!result.success) {
    throw new Error(
      `Invalid mod manifest: ${result.error.issues
        .map((i) => `${i.path.join('.')} ${i.message}`)
        .join('; ')}`,
    )
  }
  return { manifest: result.data, source }
}

/**
 * Order mods so every mod loads after its dependencies (topological sort). Throws
 * on a missing dependency or a dependency cycle.
 */
export function resolveLoadOrder(mods: readonly DiscoveredMod[]): DiscoveredMod[] {
  const byId = new Map<string, DiscoveredMod>()
  for (const mod of mods) {
    if (byId.has(mod.manifest.id)) {
      throw new Error(`Duplicate mod id: "${mod.manifest.id}"`)
    }
    byId.set(mod.manifest.id, mod)
  }

  const ordered: DiscoveredMod[] = []
  const visited = new Set<string>()
  const inProgress = new Set<string>()

  const visit = (id: string, chain: readonly string[]): void => {
    if (visited.has(id)) return
    if (inProgress.has(id)) {
      throw new Error(`Mod dependency cycle: ${[...chain, id].join(' -> ')}`)
    }
    const mod = byId.get(id)
    if (!mod) {
      throw new Error(`Missing mod dependency: "${id}" (required by ${chain.join(' -> ')})`)
    }
    inProgress.add(id)
    for (const depId of Object.keys(mod.manifest.dependencies)) {
      visit(depId, [...chain, id])
    }
    inProgress.delete(id)
    visited.add(id)
    ordered.push(mod)
  }

  for (const mod of mods) {
    visit(mod.manifest.id, [])
  }
  return ordered
}

/** Load one mod's prototype files into the registry. */
async function loadPrototypes(mod: DiscoveredMod, registry: PrototypeRegistry): Promise<number> {
  let count = 0
  for (const path of mod.manifest.prototypes) {
    const text = await mod.source.readText(path)
    const data: unknown = JSON.parse(text)
    const items = Array.isArray(data) ? data : [data]
    for (const item of items) {
      registry.register(item)
      count += 1
    }
  }
  return count
}

/**
 * Resolve, order and merge a set of discovered mods' **prototypes** into the
 * registry. Scripts are handled separately by {@link runModScripts}, because they
 * need the live world (which does not exist yet at content-load time) — prototypes
 * load first, then the world is created, then scripts run against it.
 */
export async function loadMods(
  mods: readonly DiscoveredMod[],
  registry: PrototypeRegistry,
): Promise<LoadResult> {
  const order = resolveLoadOrder(mods)
  let prototypeCount = 0
  for (const mod of order) {
    prototypeCount += await loadPrototypes(mod, registry)
  }
  return { order: order.map((m) => m.manifest), prototypeCount }
}

/**
 * A loaded mod script module: a default `init(api)` entry point, matching the shape
 * of `mods/base/scripts/main.ts`. A module without a default export contributes
 * nothing and is skipped.
 */
export interface ScriptModule {
  readonly default?: (api: ModApi) => void | Promise<void>
}

/**
 * Host-provided strategy that turns a mod's script path into an executable module.
 *
 * This lives with the **host**, not the engine, on purpose: how a script path
 * becomes a module is a runtime/build concern (dynamic `import()` under tsx, a
 * bundled chunk under Electron, an in-memory module in tests) the engine must not
 * hardcode — exactly mirroring how {@link FileSource} abstracts file access.
 */
export type ScriptResolver = (source: FileSource, path: string) => Promise<ScriptModule>

/** Result of a script-execution pass. */
export interface RunScriptsResult {
  /** Manifests in the order their scripts were executed. */
  readonly order: readonly ModManifest[]
  /** Number of script entry points actually invoked. */
  readonly scriptsRun: number
}

/**
 * Run every mod's scripts in dependency order, each against a {@link ModApi} bound
 * to its mod id. This is the (in-process, deterministic) execution step: the base
 * game in `mods/base` reaches the engine through the very same `ModApi` a
 * third-party mod receives. Throws if a script throws — bad content fails loud.
 */
export async function runModScripts(
  mods: readonly DiscoveredMod[],
  host: ModApiHost,
  resolveScript: ScriptResolver,
): Promise<RunScriptsResult> {
  const order = resolveLoadOrder(mods)
  let scriptsRun = 0
  for (const mod of order) {
    const api = createModApi(mod.manifest.id, host)
    for (const path of mod.manifest.scripts) {
      const module = await resolveScript(mod.source, path)
      if (typeof module.default === 'function') {
        await module.default(api)
        scriptsRun += 1
      }
    }
  }
  return { order: order.map((m) => m.manifest), scriptsRun }
}

/**
 * Convenience: discover each source's manifest, then load them all. Pass the base
 * game's /content source alongside any /mods sources here — there is no special
 * path for the base game.
 */
export async function discoverAndLoad(
  sources: readonly FileSource[],
  registry: PrototypeRegistry,
): Promise<LoadResult> {
  const discovered = await Promise.all(sources.map(readManifest))
  return loadMods(discovered, registry)
}
