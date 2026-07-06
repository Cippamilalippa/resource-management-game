import { useMemo, useState } from 'react'
import { useSyncExternalStore } from 'react'
import { hudStore } from './hudStore.ts'
import { focusStore } from './focusStore.ts'
import { muteStore } from './muteStore.ts'
import { alertHistoryStore, type AlertHistoryEntry } from './alertHistoryStore.ts'
import type { Alert, AlertKind } from './gameLogic.ts'
import { Icon, type IconName } from './Icon.tsx'
import { ResourceLabel } from './ResourceLabel.tsx'

/** Per-kind presentation: lucide icon, severity class, and a label builder. */
const KIND: Record<AlertKind, { icon: IconName; severity: string; label: string }> = {
  crafter_missing_input: { icon: 'PackageX', severity: 'warn', label: 'Starved crafter' },
  crafter_output_full: { icon: 'PackagePlus', severity: 'warn', label: 'Output backed up' },
  village_declining: { icon: 'TrendingDown', severity: 'bad', label: 'Village declining' },
  cannon_no_target: { icon: 'Crosshair', severity: 'warn', label: 'Cannon has no target' },
  cannon_out_of_range: { icon: 'Crosshair', severity: 'warn', label: 'Cannon target out of range' },
}

/** One alert row aggregated across every tile that raised the same kind+resource. */
interface AlertGroup {
  readonly kind: AlertKind
  readonly color?: number
  readonly count: number
  /** The first raising tile — clicking the row glides the camera here. */
  readonly x: number
  readonly y: number
  /** Every tile currently raising this group's kind+resource — muting the row mutes all of them. */
  readonly tiles: readonly { readonly x: number; readonly y: number }[]
}

/** Collapse identical alerts (same kind + resource) into a single row carrying a count. */
function groupAlerts(alerts: readonly Alert[]): AlertGroup[] {
  const byKey = new Map<string, AlertGroup>()
  for (const a of alerts) {
    const key = `${a.kind}:${a.color ?? ''}`
    const cur = byKey.get(key)
    if (cur)
      byKey.set(key, { ...cur, count: cur.count + 1, tiles: [...cur.tiles, { x: a.x, y: a.y }] })
    else
      byKey.set(key, {
        kind: a.kind,
        count: 1,
        x: a.x,
        y: a.y,
        tiles: [{ x: a.x, y: a.y }],
        ...(a.color !== undefined && { color: a.color }),
      })
  }
  return [...byKey.values()]
}

/** `HH:MM:SS` for a history entry's wall-clock timestamp. */
function formatTime(atMs: number): string {
  return new Date(atMs).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

/** One history log row: severity-tinted icon, label, raised/resolved, and a wall-clock time. */
function HistoryRow({ entry }: { entry: AlertHistoryEntry }): React.JSX.Element {
  const kind = KIND[entry.kind]
  return (
    <div className={`alert-history-row alert-${kind.severity}`}>
      <Icon name={kind.icon} size={14} />
      <span className="alert-history-text">
        {kind.label}
        {entry.color !== undefined && (
          <ResourceLabel color={entry.color} size={13} showName={false} />
        )}
      </span>
      <span className={`alert-history-event${entry.event === 'resolved' ? ' resolved' : ''}`}>
        {entry.event === 'raised' ? 'raised' : 'resolved'}
      </span>
      <span className="alert-history-time">{formatTime(entry.at)}</span>
    </div>
  )
}

/**
 * Top-right stack of live alerts (stalled crafters, backed-up outputs, declining villages),
 * aggregated so a hundred starved crafters read as one row with a count. Reads the HUD store only.
 * Each row can be muted ("don't warn for this building"); a collapsible history log below the
 * stack keeps a capped, timestamped record of alerts appearing/resolving even after they clear.
 * Renders nothing when there's no live alert, no history, and nothing muted.
 */
export function Alerts(): React.JSX.Element | null {
  const alerts = useSyncExternalStore(
    hudStore.subscribe,
    () => hudStore.get().alerts,
    () => hudStore.get().alerts,
  )
  const history = useSyncExternalStore(
    alertHistoryStore.subscribe,
    alertHistoryStore.get,
    alertHistoryStore.get,
  )
  const muted = useSyncExternalStore(muteStore.subscribe, muteStore.get, muteStore.get)
  const [historyOpen, setHistoryOpen] = useState(false)
  const groups = useMemo(() => groupAlerts(alerts), [alerts])

  if (groups.length === 0 && history.length === 0 && muted.size === 0) return null

  return (
    <div className="alerts" role="status" aria-live="polite">
      {groups.map((g) => {
        const kind = KIND[g.kind]
        return (
          <div key={`${g.kind}:${g.color ?? ''}`} className={`alert alert-${kind.severity}`}>
            <button
              type="button"
              className="alert-body"
              onClick={() => focusStore.focus(g.x, g.y)}
              title="Jump to location"
            >
              <Icon name={kind.icon} size={16} />
              <span className="alert-text">{kind.label}</span>
              {g.color !== undefined && <ResourceLabel color={g.color} size={14} />}
              {g.count > 1 && <span className="alert-count">×{g.count}</span>}
            </button>
            <button
              type="button"
              className="alert-mute"
              title="Mute this alert"
              aria-label="Mute this alert"
              onClick={() => muteStore.mute(g.tiles)}
            >
              <Icon name="X" size={12} />
            </button>
          </div>
        )
      })}
      {(history.length > 0 || muted.size > 0) && (
        <div className="alert-history-wrap">
          <button
            type="button"
            className="alert-history-toggle"
            onClick={() => setHistoryOpen((o) => !o)}
            aria-expanded={historyOpen}
          >
            <Icon name="History" size={13} />
            <span>History</span>
            {muted.size > 0 && <span className="alert-history-mutedcount">muted {muted.size}</span>}
            <Icon name={historyOpen ? 'ChevronUp' : 'ChevronDown'} size={13} />
          </button>
          {historyOpen && (
            <div className="alert-history glass">
              {muted.size > 0 && (
                <div className="alert-history-muted">
                  <span>Muted ({muted.size})</span>
                  <button type="button" onClick={() => muteStore.unmuteAll()}>
                    Unmute all
                  </button>
                </div>
              )}
              {history.length === 0 ? (
                <div className="alert-history-empty">No alerts yet.</div>
              ) : (
                history.map((e) => <HistoryRow key={e.id} entry={e} />)
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
