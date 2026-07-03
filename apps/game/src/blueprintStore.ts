/**
 * UI-side store for the copy-paste clipboard and the persistent blueprint library. Like
 * {@link buildStore} it is a tiny external store React reads via useSyncExternalStore, and
 * `placement.ts` subscribes to for mode changes. It holds *intent* only — pasting actually happens
 * through the sim command queue (`placement.ts` → `enqueue*`), never by mutating sim state here.
 *
 * Two concerns live together:
 * - **Clipboard / mode** — the transient copy-select → paste flow. `mode` drives what the pointer
 *   gestures do; `pending` is the blueprint the paste ghost stamps.
 * - **Library** — named blueprints persisted to `localStorage` so they survive restarts. Blueprints
 *   are construction templates, deliberately kept OUT of the deterministic save file.
 */
import { parseBlueprint, serializeBlueprint, type Blueprint } from './blueprint.ts'

/** A named, saved blueprint in the library. */
export interface SavedBlueprint {
  readonly id: string
  readonly name: string
  readonly blueprint: Blueprint
}

/**
 * The clipboard mode:
 * - `idle` — no clipboard tool armed.
 * - `copy-select` — dragging a rectangle to capture (see {@link BlueprintState.saveToLibrary}).
 * - `paste` — a blueprint is held; the ghost follows the cursor and a click stamps it.
 */
export type ClipboardMode = 'idle' | 'copy-select' | 'paste'

export interface BlueprintState {
  readonly mode: ClipboardMode
  /** The blueprint the paste ghost stamps (mode 'paste'), else null. */
  readonly pending: Blueprint | null
  /** When copy-select completes, save the capture to the library (naming flow) instead of pasting. */
  readonly saveToLibrary: boolean
  /** A freshly captured blueprint awaiting a name before it joins the library, or null. */
  readonly naming: Blueprint | null
  /** Whether the blueprint-library overlay is open. */
  readonly libraryOpen: boolean
  /** The persistent library, newest last. */
  readonly saved: readonly SavedBlueprint[]
}

const STORAGE_KEY = 'factory.blueprints'

/** Load the saved library from localStorage; tolerant of absent/corrupt data (returns []). */
function loadSaved(): SavedBlueprint[] {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw) as unknown
    if (!Array.isArray(arr)) return []
    const out: SavedBlueprint[] = []
    for (const item of arr) {
      const o = item as { id?: unknown; name?: unknown; blueprint?: unknown }
      if (typeof o?.id !== 'string' || typeof o?.name !== 'string') continue
      const bp = parseBlueprint(JSON.stringify(o.blueprint))
      if (bp) out.push({ id: o.id, name: o.name, blueprint: bp })
    }
    return out
  } catch {
    return []
  }
}

/** Persist the library to localStorage (best-effort; ignores quota/availability errors). */
function persist(saved: readonly SavedBlueprint[]): void {
  try {
    const plain = saved.map((s) => ({
      id: s.id,
      name: s.name,
      blueprint: JSON.parse(serializeBlueprint(s.blueprint)),
    }))
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(plain))
  } catch {
    // No localStorage (e.g. SSR/tests) or quota exceeded — the in-memory library still works.
  }
}

let state: BlueprintState = {
  mode: 'idle',
  pending: null,
  saveToLibrary: false,
  naming: null,
  libraryOpen: false,
  saved: loadSaved(),
}
const listeners = new Set<() => void>()

function set(next: Partial<BlueprintState>): void {
  state = { ...state, ...next }
  for (const l of listeners) l()
}

let idSeq = 0
/** A unique id for a saved blueprint. Host UI only — never feeds the deterministic sim. */
function nextId(): string {
  idSeq += 1
  return `bp-${Date.now().toString(36)}-${idSeq}`
}

export const blueprintStore = {
  get: (): BlueprintState => state,
  subscribe: (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },

  /** Arm copy-select. `toLibrary` routes the capture into the naming flow instead of the clipboard. */
  armCopy: (toLibrary = false): void =>
    set({ mode: 'copy-select', saveToLibrary: toLibrary, pending: null }),

  /** Arm paste with `bp` (from the clipboard or a library selection); the ghost then follows the cursor. */
  armPaste: (bp: Blueprint): void => set({ mode: 'paste', pending: bp, saveToLibrary: false }),

  /**
   * A copy-select drag finished with `bp`. Route it: into the naming flow when saving to the
   * library, otherwise straight to the paste ghost. An empty capture is dropped (back to idle).
   */
  captured: (bp: Blueprint): void => {
    if (bp.entries.length === 0) {
      set({ mode: 'idle', saveToLibrary: false })
      return
    }
    if (state.saveToLibrary) set({ mode: 'idle', saveToLibrary: false, naming: bp })
    else set({ mode: 'paste', pending: bp })
  },

  /** Commit the awaiting-name blueprint into the library under `name`. */
  saveNamed: (name: string): void => {
    if (!state.naming) return
    const entry: SavedBlueprint = {
      id: nextId(),
      name: name.trim() || `Blueprint ${state.saved.length + 1}`,
      blueprint: state.naming,
    }
    const saved = [...state.saved, entry]
    persist(saved)
    set({ saved, naming: null })
  },

  /** Abandon the awaiting-name capture without saving. */
  cancelNaming: (): void => set({ naming: null }),

  /** Open/close the blueprint-library overlay. */
  toggleLibrary: (): void => set({ libraryOpen: !state.libraryOpen }),

  /** Close the blueprint-library overlay. */
  closeLibrary: (): void => set({ libraryOpen: false }),

  /** Select a saved blueprint by id and arm paste with it (closing the library). */
  selectSaved: (id: string): void => {
    const found = state.saved.find((s) => s.id === id)
    if (found)
      set({ mode: 'paste', pending: found.blueprint, saveToLibrary: false, libraryOpen: false })
  },

  /** Rename a saved blueprint. */
  renameSaved: (id: string, name: string): void => {
    const saved = state.saved.map((s) => (s.id === id ? { ...s, name: name.trim() || s.name } : s))
    persist(saved)
    set({ saved })
  },

  /** Delete a saved blueprint from the library. */
  deleteSaved: (id: string): void => {
    const saved = state.saved.filter((s) => s.id !== id)
    persist(saved)
    set({ saved })
  },

  /** Disarm any clipboard tool (return to idle); leaves the library untouched. */
  cancel: (): void => set({ mode: 'idle', pending: null, saveToLibrary: false }),
}
