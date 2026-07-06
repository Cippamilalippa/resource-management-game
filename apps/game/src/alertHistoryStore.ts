/**
 * App-side alert history log (U6): each throttled HUD refresh diffs the live (mute-filtered)
 * `Alert[]` against the previous sample and records a wall-clock-timestamped, capped (~50) log
 * entry whenever a source (a specific kind at a specific tile) appears or disappears. Pure
 * UI-side bookkeeping over a selector's read-only output — it never reads or writes sim state
 * itself, so determinism is untouched.
 */
import type { Alert, AlertKind } from './gameLogic.ts'

/** Most recent entries first; older entries fall off past this cap. */
const MAX_HISTORY = 50

export interface AlertHistoryEntry {
  readonly id: number
  readonly kind: AlertKind
  readonly x: number
  readonly y: number
  readonly color?: number
  readonly event: 'raised' | 'resolved'
  /** Wall-clock ms (`Date.now()`), never the sim tick. */
  readonly at: number
}

/** Identity of one alert *source*: a specific kind at a specific tile (independent of colour). */
function sourceKey(a: Pick<Alert, 'kind' | 'x' | 'y'>): string {
  return `${a.kind}@${a.x},${a.y}`
}

/** Sources present in `curr` but not `prev` (raised) and vice versa (resolved). Pure — order
 * follows each input array's own order. */
export function diffAlerts(
  prev: readonly Alert[],
  curr: readonly Alert[],
): { readonly raised: readonly Alert[]; readonly resolved: readonly Alert[] } {
  const prevKeys = new Set(prev.map(sourceKey))
  const currKeys = new Set(curr.map(sourceKey))
  const raised = curr.filter((a) => !prevKeys.has(sourceKey(a)))
  const resolved = prev.filter((a) => !currKeys.has(sourceKey(a)))
  return { raised, resolved }
}

/** Prepend newly raised/resolved entries (raised before resolved) to `history`, capped to
 * {@link MAX_HISTORY} and most-recent-first. Pure — the caller supplies the wall-clock timestamp
 * and the next free id so this stays independent of `Date.now()`/module state for testing. */
export function foldHistory(
  history: readonly AlertHistoryEntry[],
  raised: readonly Alert[],
  resolved: readonly Alert[],
  at: number,
  nextId: number,
): { readonly history: readonly AlertHistoryEntry[]; readonly nextId: number } {
  const additions: AlertHistoryEntry[] = []
  let id = nextId
  for (const a of raised) {
    additions.push({
      id: id++,
      kind: a.kind,
      x: a.x,
      y: a.y,
      ...(a.color !== undefined ? { color: a.color } : {}),
      event: 'raised',
      at,
    })
  }
  for (const a of resolved) {
    additions.push({
      id: id++,
      kind: a.kind,
      x: a.x,
      y: a.y,
      ...(a.color !== undefined ? { color: a.color } : {}),
      event: 'resolved',
      at,
    })
  }
  if (additions.length === 0) return { history, nextId: id }
  return { history: [...additions, ...history].slice(0, MAX_HISTORY), nextId: id }
}

let prevAlerts: readonly Alert[] = []
let history: readonly AlertHistoryEntry[] = []
let nextId = 1
const listeners = new Set<() => void>()

export const alertHistoryStore = {
  /** Diff `alerts` (already mute-filtered) against the last sample and fold any raised/resolved
   * sources into the log. Called once per throttled HUD refresh. */
  record(alerts: readonly Alert[], now: number = Date.now()): void {
    const diff = diffAlerts(prevAlerts, alerts)
    prevAlerts = alerts
    if (diff.raised.length === 0 && diff.resolved.length === 0) return
    const next = foldHistory(history, diff.raised, diff.resolved, now, nextId)
    history = next.history
    nextId = next.nextId
    for (const l of listeners) l()
  },
  get(): readonly AlertHistoryEntry[] {
    return history
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  /** Drop all history — called when a session is replaced (new game / load). */
  reset(): void {
    prevAlerts = []
    history = []
    nextId = 1
    for (const l of listeners) l()
  },
}
