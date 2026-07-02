/**
 * Main-process save manager: the only code that touches the save files on disk. The
 * sandboxed renderer has no fs access, so it hands us an opaque engine `WorldSnapshot`
 * over IPC and we persist it, and it asks us to list/load/delete slots. The engine stays
 * game-agnostic — we never interpret the snapshot beyond reading a few header fields for
 * the metadata card (tick, seed, version).
 *
 * Slot model (see {@link SaveKind}): many `manual` slots keyed by a generated id; one
 * reserved `quick` slot overwritten in place; a small rotating set of `auto` slots pruned
 * to the last {@link AUTOSAVE_KEEP}.
 */
import { app } from 'electron'
import { mkdir, readdir, readFile, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  AUTOSAVE_KEEP,
  QUICKSAVE_ID,
  SAVE_EXT,
  SAVE_FILE_VERSION,
  type SaveKind,
  type SaveMeta,
  type SavePayload,
  type SaveRequest,
} from './saveTypes.ts'

/** The on-disk file: a metadata envelope plus the opaque engine snapshot it describes. */
interface SaveFile {
  readonly fileVersion: number
  readonly meta: SaveMeta
  readonly snapshot: unknown
}

/** The few header fields we read off an engine `WorldSnapshot` to build a metadata card. */
interface SnapshotHeader {
  version?: unknown
  tick?: unknown
  seed?: unknown
}

/** Absolute path to the saves directory under the OS-standard per-user app data location. */
function savesDir(): string {
  return join(app.getPath('userData'), 'saves')
}

/** Ensure the saves directory exists before any read/write. */
async function ensureDir(): Promise<string> {
  const dir = savesDir()
  await mkdir(dir, { recursive: true })
  return dir
}

/**
 * Only allow slot ids that map safely to a single filename — a slot id becomes `<id>.factorysave`,
 * so anything with path separators or dots is rejected to keep writes inside the saves dir.
 */
function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(id)
}

/** Absolute path to a slot's file. Assumes {@link isSafeId} has already vetted the id. */
function fileForId(dir: string, id: string): string {
  return join(dir, `${id}${SAVE_EXT}`)
}

/** Read a numeric header field off the opaque snapshot, or 0 when absent/ill-typed. */
function headerNumber(snapshot: unknown, key: keyof SnapshotHeader): number {
  const v = (snapshot as SnapshotHeader | null)?.[key]
  return typeof v === 'number' ? v : 0
}

/** Parse and lightly validate a save file's contents; returns null if it isn't one of ours. */
function parseSaveFile(text: string): SaveFile | null {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof data !== 'object' || data === null) return null
  const file = data as Partial<SaveFile>
  if (file.fileVersion !== SAVE_FILE_VERSION) return null
  if (typeof file.meta !== 'object' || file.meta === null) return null
  if (!('snapshot' in file)) return null
  return file as SaveFile
}

/** Read one slot's file (metadata + snapshot), or null if missing/corrupt. */
async function readFileForId(dir: string, id: string): Promise<SaveFile | null> {
  try {
    return parseSaveFile(await readFile(fileForId(dir, id), 'utf8'))
  } catch {
    return null // missing file — treat as absent, not fatal.
  }
}

/**
 * List every valid save's metadata, newest write first. Corrupt or foreign files in the
 * directory are skipped rather than failing the whole list.
 */
export async function listSaves(): Promise<SaveMeta[]> {
  const dir = await ensureDir()
  const names = await readdir(dir)
  const metas: SaveMeta[] = []
  for (const name of names) {
    if (!name.endsWith(SAVE_EXT)) continue
    const file = parseSaveFile(await readFile(join(dir, name), 'utf8').catch(() => ''))
    if (file) metas.push(file.meta)
  }
  return metas.sort((a, b) => b.updatedAt - a.updatedAt)
}

/** The autosave slots currently on disk, oldest first (prune order). */
async function existingAutosaves(): Promise<SaveMeta[]> {
  const metas = await listSaves()
  return metas.filter((m) => m.kind === 'auto').sort((a, b) => a.updatedAt - b.updatedAt)
}

/** A human default label for a freshly created slot of the given kind. */
function defaultName(kind: SaveKind, tick: number): string {
  if (kind === 'quick') return 'Quicksave'
  if (kind === 'auto') return 'Autosave'
  return `Save @ tick ${tick.toLocaleString()}`
}

/**
 * Persist a snapshot into a slot and return the slot's metadata. The id is chosen by kind:
 * quick uses the reserved {@link QUICKSAVE_ID}; auto mints a fresh id and prunes older
 * autosaves down to {@link AUTOSAVE_KEEP}; manual overwrites `req.id` when given (preserving
 * its original `createdAt` and name unless a new name is supplied) or mints a new id.
 */
export async function saveGame(req: SaveRequest): Promise<SaveMeta> {
  const dir = await ensureDir()
  const now = Date.now()
  const tick = headerNumber(req.snapshot, 'tick')
  const seed = headerNumber(req.snapshot, 'seed')
  const snapshotVersion = headerNumber(req.snapshot, 'version')

  let id: string
  if (req.kind === 'quick') {
    id = QUICKSAVE_ID
  } else if (req.kind === 'auto') {
    id = `autosave-${randomUUID()}`
    // Make room: prune the oldest autosaves so that after this write we keep at most KEEP.
    const autos = await existingAutosaves()
    const excess = autos.length - (AUTOSAVE_KEEP - 1)
    for (let i = 0; i < excess; i++) await deleteSave(autos[i]!.id)
  } else {
    id = req.id && isSafeId(req.id) ? req.id : randomUUID()
  }

  // Preserve the slot's original creation time and (for manual overwrites) its existing name
  // when the caller didn't pass a new one.
  const prior = await readFileForId(dir, id)
  const createdAt = prior?.meta.createdAt ?? now
  const name = req.name ?? prior?.meta.name ?? defaultName(req.kind, tick)

  const meta: SaveMeta = {
    id,
    name,
    kind: req.kind,
    tick,
    seed,
    snapshotVersion,
    createdAt,
    updatedAt: now,
  }
  const file: SaveFile = { fileVersion: SAVE_FILE_VERSION, meta, snapshot: req.snapshot }
  await writeFile(fileForId(dir, id), JSON.stringify(file), 'utf8')
  return meta
}

/** Load a slot's metadata + snapshot for the renderer to restore. Throws if the slot is gone. */
export async function loadGame(id: string): Promise<SavePayload> {
  if (!isSafeId(id)) throw new Error(`invalid save id: ${id}`)
  const dir = await ensureDir()
  const file = await readFileForId(dir, id)
  if (!file) throw new Error(`save not found or unreadable: ${id}`)
  return { meta: file.meta, snapshot: file.snapshot }
}

/** Delete a slot. A missing file is not an error (idempotent). */
export async function deleteSave(id: string): Promise<void> {
  if (!isSafeId(id)) throw new Error(`invalid save id: ${id}`)
  const dir = await ensureDir()
  await unlink(fileForId(dir, id)).catch(() => undefined)
}

/** Rename a manual slot in place (keeps its snapshot and timestamps). Throws if the slot is gone. */
export async function renameSave(id: string, name: string): Promise<SaveMeta> {
  if (!isSafeId(id)) throw new Error(`invalid save id: ${id}`)
  const dir = await ensureDir()
  const file = await readFileForId(dir, id)
  if (!file) throw new Error(`save not found: ${id}`)
  const meta: SaveMeta = { ...file.meta, name }
  await writeFile(fileForId(dir, id), JSON.stringify({ ...file, meta }), 'utf8')
  return meta
}
