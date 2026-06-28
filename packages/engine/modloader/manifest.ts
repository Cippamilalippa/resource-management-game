import { z } from 'zod'

/**
 * A mod manifest. The BASE GAME in /content uses this exact shape — it is loaded
 * as "mod zero" through the very same pipeline a third-party mod uses. There is no
 * special-cased path for the base game.
 */
export const modManifestSchema = z.object({
  /** Globally unique mod id. */
  id: z.string().min(1),
  /** Semver-ish version string (not parsed yet). */
  version: z.string().min(1),
  /** Human-friendly name (optional). */
  name: z.string().optional(),
  /** Other mod ids this mod must load after. Map of id -> version range. */
  dependencies: z.record(z.string(), z.string()).default({}),
  /** Prototype JSON files to load, relative to the mod root. */
  prototypes: z.array(z.string()).default([]),
  /** Script entrypoints, relative to the mod root (execution is a stub for now). */
  scripts: z.array(z.string()).default([]),
})

export type ModManifest = z.infer<typeof modManifestSchema>
