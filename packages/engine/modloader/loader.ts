import type { PrototypeRegistry } from '../data/index.ts'
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
 * Resolve, order and merge a set of discovered mods into the registry. Script
 * execution is intentionally a no-op stub for this pass — we only prove that
 * content flows through the mod pipeline.
 */
export async function loadMods(
  mods: readonly DiscoveredMod[],
  registry: PrototypeRegistry,
): Promise<LoadResult> {
  const order = resolveLoadOrder(mods)
  let prototypeCount = 0
  for (const mod of order) {
    prototypeCount += await loadPrototypes(mod, registry)
    // Scripts: execution sandbox is out of scope; just note they exist.
    if (mod.manifest.scripts.length > 0) {
      console.log(
        `[modloader] ${mod.manifest.id}: ${mod.manifest.scripts.length} script(s) registered (execution stubbed)`,
      )
    }
  }
  return { order: order.map((m) => m.manifest), prototypeCount }
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
