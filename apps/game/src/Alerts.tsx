import { useMemo } from 'react'
import { useSyncExternalStore } from 'react'
import { hudStore } from './hudStore.ts'
import type { Alert, AlertKind } from './gameLogic.ts'
import { Icon, type IconName } from './Icon.tsx'
import { ResourceLabel } from './ResourceLabel.tsx'

/** Per-kind presentation: lucide icon, severity class, and a label builder. */
const KIND: Record<AlertKind, { icon: IconName; severity: string; label: string }> = {
  crafter_missing_input: { icon: 'PackageX', severity: 'warn', label: 'Starved crafter' },
  crafter_output_full: { icon: 'PackagePlus', severity: 'warn', label: 'Output backed up' },
  village_declining: { icon: 'TrendingDown', severity: 'bad', label: 'Village declining' },
}

/** One alert row aggregated across every tile that raised the same kind+resource. */
interface AlertGroup {
  readonly kind: AlertKind
  readonly color?: number
  readonly count: number
}

/** Collapse identical alerts (same kind + resource) into a single row carrying a count. */
function groupAlerts(alerts: readonly Alert[]): AlertGroup[] {
  const byKey = new Map<string, AlertGroup>()
  for (const a of alerts) {
    const key = `${a.kind}:${a.color ?? ''}`
    const cur = byKey.get(key)
    if (cur) byKey.set(key, { ...cur, count: cur.count + 1 })
    else
      byKey.set(key, { kind: a.kind, count: 1, ...(a.color !== undefined && { color: a.color }) })
  }
  return [...byKey.values()]
}

/**
 * Top-right stack of live alerts (stalled crafters, backed-up outputs, declining villages),
 * aggregated so a hundred starved crafters read as one row with a count. Reads the HUD store only.
 * Renders nothing when all is well.
 */
export function Alerts(): React.JSX.Element | null {
  const alerts = useSyncExternalStore(
    hudStore.subscribe,
    () => hudStore.get().alerts,
    () => hudStore.get().alerts,
  )
  const groups = useMemo(() => groupAlerts(alerts), [alerts])
  if (groups.length === 0) return null

  return (
    <div className="alerts" role="status" aria-live="polite">
      {groups.map((g) => {
        const kind = KIND[g.kind]
        return (
          <div key={`${g.kind}:${g.color ?? ''}`} className={`alert alert-${kind.severity}`}>
            <Icon name={kind.icon} size={16} />
            <span className="alert-text">{kind.label}</span>
            {g.color !== undefined && <ResourceLabel color={g.color} size={14} />}
            {g.count > 1 && <span className="alert-count">×{g.count}</span>}
          </div>
        )
      })}
    </div>
  )
}
