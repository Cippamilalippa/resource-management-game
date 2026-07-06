/**
 * Save-system types shared by the Electron main process (which reads/writes the files)
 * and the renderer (which drives the UI). Kept free of any runtime imports — no `electron`,
 * no `node:fs` — so the renderer can import it without pulling the main-process fs code into
 * its bundle. Only plain types and pure constants live here.
 */

/**
 * What produced a save slot:
 * - `manual` — a named slot the player created (many allowed; each has a stable id).
 * - `quick`  — the single quicksave slot; a new quicksave overwrites it in place.
 * - `auto`   — an autosave; the manager keeps the last {@link AUTOSAVE_KEEP} and prunes older ones.
 */
export type SaveKind = 'manual' | 'quick' | 'auto'

/** The reserved id of the one-and-only quicksave slot (overwritten each quicksave). */
export const QUICKSAVE_ID = 'quicksave'
/** How many autosave slots to retain; older autosaves beyond this are pruned. */
export const AUTOSAVE_KEEP = 3
/** Filename extension for every save file under the saves directory. */
export const SAVE_EXT = '.factorysave'
/** On-disk envelope schema version (distinct from the engine's sim SNAPSHOT_VERSION). */
export const SAVE_FILE_VERSION = 1

/**
 * The metadata card shown for a save in the load/save list. Small enough to read for every
 * file when listing; the heavy `snapshot` blob is only read on an actual load.
 */
export interface SaveMeta {
  readonly id: string
  readonly name: string
  readonly kind: SaveKind
  /** Sim tick the save was taken at — the closest thing to a play-time readout. */
  readonly tick: number
  /** World seed, carried for display and so a load recreates the same RNG stream. */
  readonly seed: number
  /** The engine snapshot version inside this save, used to gate/flag incompatible loads. */
  readonly snapshotVersion: number
  /** Epoch ms when the slot was first created (stable across overwrites of the same slot). */
  readonly createdAt: number
  /** Epoch ms of the most recent write to the slot. */
  readonly updatedAt: number
  /**
   * Optional small preview of the world at save time: a downscaled (~192px wide) JPEG data-URL
   * captured from the Pixi canvas by the renderer. Added additively — older saves simply lack it,
   * and the slot list falls back to a placeholder when absent.
   */
  readonly thumbnail?: string
  /**
   * Optional accumulated wall-clock play time in seconds, carried across save/load. Added
   * additively — older saves lack it, and the slot list falls back to "—" when absent.
   */
  readonly playTimeSec?: number
}

/** A request from the renderer to persist the current sim. `snapshot` is the opaque engine blob. */
export interface SaveRequest {
  readonly kind: SaveKind
  /** Display name (manual saves). Ignored for quick/auto, which own their labels. */
  readonly name?: string
  /** Overwrite this existing manual slot; omit to create a new one. Ignored for quick/auto. */
  readonly id?: string
  /** The engine `WorldSnapshot` (typed opaquely here so this module stays import-free). */
  readonly snapshot: unknown
  /** See {@link SaveMeta.thumbnail}. Captured renderer-side (the main process has no canvas). */
  readonly thumbnail?: string
  /** See {@link SaveMeta.playTimeSec}. Tracked renderer-side and handed over at save time. */
  readonly playTimeSec?: number
}

/** The result of loading a slot: its metadata plus the opaque engine snapshot to restore. */
export interface SavePayload {
  readonly meta: SaveMeta
  readonly snapshot: unknown
}

/**
 * Merge a save's core fields with its optional thumbnail/play-time extras: prefer the incoming
 * request's values, falling back to the slot's prior write when the request omits one (e.g. a
 * thumbnail capture that failed this write shouldn't blank out an existing preview). Pure and
 * import-free — unlike `saves.ts` this needs no Electron runtime, so it's unit-testable directly.
 */
export function withSaveExtras(
  core: Omit<SaveMeta, 'thumbnail' | 'playTimeSec'>,
  req: Pick<SaveRequest, 'thumbnail' | 'playTimeSec'>,
  prior?: Pick<SaveMeta, 'thumbnail' | 'playTimeSec'>,
): SaveMeta {
  const thumbnail = req.thumbnail ?? prior?.thumbnail
  const playTimeSec = typeof req.playTimeSec === 'number' ? req.playTimeSec : prior?.playTimeSec
  return {
    ...core,
    ...(thumbnail ? { thumbnail } : {}),
    ...(playTimeSec !== undefined ? { playTimeSec } : {}),
  }
}
