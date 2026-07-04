/**
 * UI-side undo/redo history for build gestures. Like the other small stores it is an external
 * store React can read via useSyncExternalStore, but its real job is to remember, for each
 * player build gesture, the commands that *reverse* it and the commands that *replay* it.
 *
 * It holds intent only — it never touches sim state. Undo/redo work by enqueueing ordinary
 * commands through an injected {@link Dispatch} (wired once in `placement.ts` to the sim command
 * queue), exactly as the original gesture did. Because both directions go through the normal
 * deferred-command path, refunds/charges net out and determinism is untouched: the engine sees
 * only regular `place_*` / `remove` commands, never a special "undo" op.
 *
 * v1 scope is **structural placement**: a placement's inverse is a `remove` at the tile(s) it
 * filled, and its replay is the original `place_*` command. Undoing a *deletion* would need the
 * sim to echo the removed entity's full descriptor (recipe, filters, links), which is a later,
 * larger change — so deletions are not recorded here yet.
 */

/** A deferred sim command, structurally identical to the engine's `Command` (kept engine-free). */
export interface HistoryCommand {
  readonly type: string
  readonly [key: string]: unknown
}

/**
 * One undoable gesture. `undo` reverses it, `redo` replays it — each an ordered list so a
 * multi-tile gesture (a belt run, a blueprint paste) collapses into a single history step.
 */
export interface HistoryEntry {
  /** Short human label for a future "Undo <label>" affordance. */
  readonly label: string
  /** Commands that reverse the gesture, applied in order. */
  readonly undo: readonly HistoryCommand[]
  /** Commands that replay the gesture, applied in order. */
  readonly redo: readonly HistoryCommand[]
}

/** Sink the store enqueues reversing/replaying commands through (the sim command queue). */
export type Dispatch = (cmd: HistoryCommand) => void

/** Cap the retained history so a long session can't grow the stacks without bound. */
const MAX_HISTORY = 100

export interface HistoryView {
  readonly canUndo: boolean
  readonly canRedo: boolean
  /** Label of the entry Ctrl+Z would reverse, or null. */
  readonly undoLabel: string | null
  /** Label of the entry Ctrl+Shift+Z would replay, or null. */
  readonly redoLabel: string | null
}

const past: HistoryEntry[] = []
const future: HistoryEntry[] = []
let dispatch: Dispatch | null = null

let view: HistoryView = { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null }
const listeners = new Set<() => void>()

function refresh(): void {
  view = {
    canUndo: past.length > 0,
    canRedo: future.length > 0,
    undoLabel: past.length > 0 ? past[past.length - 1]!.label : null,
    redoLabel: future.length > 0 ? future[future.length - 1]!.label : null,
  }
  for (const l of listeners) l()
}

export const historyStore = {
  get: (): HistoryView => view,
  subscribe: (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },

  /** Wire the command sink (once, from `placement.ts`). */
  setDispatch: (fn: Dispatch): void => {
    dispatch = fn
  },

  /**
   * Record a completed gesture. Pushing a fresh action invalidates the redo branch (standard
   * linear-history semantics) and drops the oldest entry once the cap is reached.
   */
  push: (entry: HistoryEntry): void => {
    if (entry.undo.length === 0 && entry.redo.length === 0) return
    past.push(entry)
    if (past.length > MAX_HISTORY) past.shift()
    future.length = 0
    refresh()
  },

  /** Reverse the most recent gesture; returns false when there is nothing to undo. */
  undo: (): boolean => {
    const entry = past.pop()
    if (!entry) return false
    if (dispatch) for (const cmd of entry.undo) dispatch(cmd)
    future.push(entry)
    refresh()
    return true
  },

  /** Replay the most recently undone gesture; returns false when there is nothing to redo. */
  redo: (): boolean => {
    const entry = future.pop()
    if (!entry) return false
    if (dispatch) for (const cmd of entry.redo) dispatch(cmd)
    past.push(entry)
    refresh()
    return true
  },

  /** Drop all history — call when a session is replaced (new game / load), so stale inverses
   * from the old world can never be applied to the new one. */
  reset: (): void => {
    past.length = 0
    future.length = 0
    refresh()
  },
}
