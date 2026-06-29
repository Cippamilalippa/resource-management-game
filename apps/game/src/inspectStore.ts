/**
 * UI-side store for the inspector sidebar: the description of the object under the cursor
 * (or the pinned one) plus whether it is pinned. Like {@link statsStore} it is a tiny
 * external store React reads via useSyncExternalStore, keeping the Pixi/React layers
 * decoupled. It holds a read-only *view* of sim state; nothing here mutates the world.
 */
import type { InspectInfo } from './inspect.ts'

export interface InspectState {
  /** What to show, or null to hide the sidebar. */
  readonly info: InspectInfo | null
  /** Whether `info` is a pinned (clicked) selection rather than a transient hover. */
  readonly pinned: boolean
}

let state: InspectState = { info: null, pinned: false }
const listeners = new Set<() => void>()
// The input controller owns the pin lifecycle; the sidebar's close button asks it to
// release through this handler so the controller's state and the store never diverge.
let unpinHandler: (() => void) | null = null

function set(next: InspectState): void {
  state = next
  for (const l of listeners) l()
}

export const inspectStore = {
  get: (): InspectState => state,
  set,
  subscribe: (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  /** Register the controller's unpin action (called by the sidebar's close button). */
  onUnpin: (fn: () => void): void => {
    unpinHandler = fn
  },
  /** Ask the controller to release the current pin. */
  unpin: (): void => unpinHandler?.(),
}
