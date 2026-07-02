/**
 * External store bridging the save/load menu (React) to the imperative session controller
 * (owned by the boot loop in main.tsx, which alone can swap the running sim). The menu reads
 * this state via useSyncExternalStore and calls through {@link SaveController}; the boot loop
 * pushes state updates (slot list, busy/toast/error, pause). Keeps React out of the sim loop.
 */
import type { SaveMeta } from '../electron/preload.ts'

export interface SaveUiState {
  /** Whether the save/load overlay is open (the sim is paused while it is). */
  readonly open: boolean
  /** True while a disk operation is in flight (disables the buttons). */
  readonly busy: boolean
  /** All slots on disk, newest first. */
  readonly saves: readonly SaveMeta[]
  /** The slot this session was last loaded from or saved into (highlighted in the list). */
  readonly activeId: string | null
  /** A sticky error from the last failed operation, shown in the menu. */
  readonly error: string | null
  /** A transient confirmation ("Quicksaved", "Loaded") shown briefly as a corner toast. */
  readonly toast: string | null
}

/**
 * The imperative surface the menu drives. Implemented in the boot loop (main.tsx) because only it
 * can build/swap a live session. Every method that touches disk is async and reports progress
 * through the store (busy/toast/error), so the menu never talks to the Electron bridge directly.
 */
export interface SaveController {
  open(): void
  close(): void
  /** Re-read the slot list from disk. */
  refresh(): Promise<void>
  /** Overwrite the single quicksave slot with the current sim. */
  quickSave(): Promise<void>
  /** Restore the quicksave slot (no-op with a toast if there isn't one). */
  quickLoad(): Promise<void>
  /** Create a new named manual slot from the current sim. */
  saveNew(name: string): Promise<void>
  /** Overwrite an existing slot with the current sim. */
  overwrite(meta: SaveMeta): Promise<void>
  /** Load a slot, swapping the running session for the restored world. */
  load(meta: SaveMeta): Promise<void>
  /** Delete a slot from disk. */
  remove(meta: SaveMeta): Promise<void>
  /** Abandon the current sim and start a fresh game. */
  newGame(): Promise<void>
}

const initial: SaveUiState = {
  open: false,
  busy: false,
  saves: [],
  activeId: null,
  error: null,
  toast: null,
}

let state: SaveUiState = initial
let controller: SaveController | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) l()
}

export const saveStore = {
  get: (): SaveUiState => state,
  /** Merge a partial update and notify subscribers. */
  set: (patch: Partial<SaveUiState>): void => {
    state = { ...state, ...patch }
    emit()
  },
  subscribe: (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  /** Wire the boot loop's controller in once the session exists. */
  setController: (c: SaveController): void => {
    controller = c
  },
  getController: (): SaveController | null => controller,
}
