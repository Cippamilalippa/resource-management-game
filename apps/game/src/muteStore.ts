/**
 * App-side "don't warn for this building" mutes for the alert stack (U6). Storing tile keys
 * (rather than an alert kind/colour) mutes a *source* outright — once a building is muted, none
 * of its future alerts (of any kind) reach the live stack or the history log. Read-only w.r.t. the
 * sim: this only ever filters `Alert[]` the HUD selector already produced.
 */
import { tileKey } from './gameLogic.ts'

/** Keep only the items whose (x, y) tile is not in `muted`. Pure — used by the live alert stack, the
 * status overlay, and the history log so all three agree on what's silenced. */
export function filterMuted<T extends { readonly x: number; readonly y: number }>(
  items: readonly T[],
  muted: ReadonlySet<number>,
): T[] {
  if (muted.size === 0) return items.slice()
  return items.filter((i) => !muted.has(tileKey(i.x, i.y)))
}

let muted: ReadonlySet<number> = new Set()
const listeners = new Set<() => void>()

function notify(): void {
  for (const l of listeners) l()
}

export const muteStore = {
  isMuted(x: number, y: number): boolean {
    return muted.has(tileKey(x, y))
  },
  /** Mute every tile in `tiles` (e.g. every building an aggregated alert row currently covers). */
  mute(tiles: readonly { readonly x: number; readonly y: number }[]): void {
    if (tiles.length === 0) return
    const next = new Set(muted)
    for (const t of tiles) next.add(tileKey(t.x, t.y))
    muted = next
    notify()
  },
  unmute(x: number, y: number): void {
    const key = tileKey(x, y)
    if (!muted.has(key)) return
    const next = new Set(muted)
    next.delete(key)
    muted = next
    notify()
  },
  unmuteAll(): void {
    if (muted.size === 0) return
    muted = new Set()
    notify()
  },
  /** Every currently muted tile key, for the "muted (N)" row. */
  get(): ReadonlySet<number> {
    return muted
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  /** Drop all mutes — called when a session is replaced (new game / load). */
  reset(): void {
    if (muted.size === 0) return
    muted = new Set()
    notify()
  },
}
