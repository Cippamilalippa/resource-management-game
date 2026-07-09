import { useEffect, useRef } from 'react'

/**
 * A single open modal in the global stack. `close` dismisses exactly this modal; it is invoked by the
 * central Esc handler (see {@link installModalEscape}) when this entry is on top.
 */
export interface ModalEntry {
  readonly id: string
  readonly close: () => void
}

let stack: readonly ModalEntry[] = []
const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) l()
}

/**
 * The app's modal stack. Each modal registers itself while open (via {@link useModal}); the boot loop
 * installs one capture-phase Esc handler ({@link installModalEscape}) that closes the topmost. This
 * replaces the per-modal `window` keydown listeners that each swallowed Esc while an input inside the
 * modal was focused — the central handler runs *before* that input guard, so Esc always closes the
 * modal on top no matter what has focus. UI-only: holds no sim state and never affects determinism.
 */
export const modalStore = {
  get: (): readonly ModalEntry[] => stack,
  subscribe: (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  isOpen: (): boolean => stack.length > 0,
  top: (): ModalEntry | undefined => stack[stack.length - 1],
  /** Register (or move to the top) a modal as open. Idempotent per `id`. */
  push: (id: string, close: () => void): void => {
    stack = [...stack.filter((m) => m.id !== id), { id, close }]
    emit()
  },
  /** Drop a modal from the stack (on close/unmount). No-op if it isn't registered. */
  remove: (id: string): void => {
    if (!stack.some((m) => m.id === id)) return
    stack = stack.filter((m) => m.id !== id)
    emit()
  },
  /** Close the topmost open modal. Returns true if one was closed (Esc consumed). */
  closeTop: (): boolean => {
    const top = stack[stack.length - 1]
    if (top === undefined) return false
    top.close()
    return true
  },
}

/**
 * Register a modal in the global stack for as long as `open` is true. The latest `close` closure is
 * always used (kept in a ref) so callers can pass an inline arrow without re-registering each render.
 * Removes itself when `open` goes false or the component unmounts.
 */
export function useModal(id: string, open: boolean, close: () => void): void {
  const closeRef = useRef(close)
  closeRef.current = close
  useEffect(() => {
    if (!open) return undefined
    modalStore.push(id, () => closeRef.current())
    return () => modalStore.remove(id)
  }, [id, open])
}

/**
 * Install the single global Esc handler that closes the topmost modal. Registered in the capture
 * phase so it runs before any focused input or bubble-phase listener sees the key — that is what lets
 * Esc close a modal whose search box is focused. `stopImmediatePropagation` prevents the build-tool
 * deselect (and any other window Esc handler) from also firing. When no modal is open the key is left
 * untouched, so Esc still deselects the armed build tool. Returns an unsubscribe for symmetry.
 */
export function installModalEscape(): () => void {
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || !modalStore.isOpen()) return
    e.preventDefault()
    e.stopImmediatePropagation()
    modalStore.closeTop()
  }
  window.addEventListener('keydown', onKey, true)
  return () => window.removeEventListener('keydown', onKey, true)
}
