/**
 * Minimal typed, synchronous event bus. Systems and (read-only) consumers use
 * this to communicate without hard references to each other. Listeners fire in
 * registration order so behaviour stays deterministic.
 *
 * The event map is open-ended so game content / mods can declare their own
 * events without the engine knowing about them.
 */
export type EventMap = Record<string, unknown>

export type Listener<T> = (payload: T) => void

export class EventBus<Events extends EventMap = EventMap> {
  #listeners = new Map<keyof Events, Set<Listener<unknown>>>()

  /** Subscribe to an event. Returns an unsubscribe function. */
  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    let set = this.#listeners.get(event)
    if (!set) {
      set = new Set()
      this.#listeners.set(event, set)
    }
    set.add(listener as Listener<unknown>)
    return () => {
      this.#listeners.get(event)?.delete(listener as Listener<unknown>)
    }
  }

  /** Emit an event to all current listeners, in registration order. */
  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.#listeners.get(event)
    if (!set) return
    for (const listener of set) {
      listener(payload)
    }
  }

  /** Drop every listener (used when tearing a world down). */
  clear(): void {
    this.#listeners.clear()
  }
}
