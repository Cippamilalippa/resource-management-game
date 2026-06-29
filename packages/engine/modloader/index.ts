/**
 * engine/modloader — defines the mod manifest shape and the pipeline that
 * resolves dependencies, orders mods and merges their prototypes into the
 * registry. The base game (mods/base) is discovered and loaded through this
 * same path as "mod zero".
 */
export { modManifestSchema, type ModManifest } from './manifest.ts'
export { type FileSource } from './fileSource.ts'
export { NodeFileSource, discoverModSources } from './nodeFileSource.ts'
export {
  readManifest,
  resolveLoadOrder,
  loadMods,
  discoverAndLoad,
  type DiscoveredMod,
  type LoadResult,
} from './loader.ts'
