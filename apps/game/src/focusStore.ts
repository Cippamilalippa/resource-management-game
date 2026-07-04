/**
 * Tiny bridge letting read-only UI (e.g. the alert stack) ask the camera to glide to a world tile,
 * without holding a reference to the renderer. `main.tsx` wires the controller to the live
 * renderer's `focusTile`; components call {@link focusStore.focus}. Purely a view action — it never
 * touches sim state, so it cannot affect determinism.
 */
export type FocusController = (x: number, y: number) => void

let controller: FocusController | null = null

export const focusStore = {
  setController: (fn: FocusController | null): void => {
    controller = fn
  },
  /** Glide the camera to centre tile (x, y); a no-op until a session wires the controller. */
  focus: (x: number, y: number): void => {
    controller?.(x, y)
  },
}
