import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { statsHistory, mean, trendDirection, type StatsWindow, type Trend } from './statsHistory.ts'
import { resourceByColor } from './resources.ts'
import { Icon, type IconName } from './Icon.tsx'
import { ResourceLabel } from './ResourceLabel.tsx'

/** A packed 0xRRGGBB colour as a CSS hex string. */
function cssColor(color: number): string {
  return `#${(color >>> 0).toString(16).padStart(6, '0')}`
}

/** Format a non-negative per-minute rate: two decimals below 10, rounded above. */
function perMinRate(v: number): string {
  if (v <= 0) return '0/min'
  return `${v >= 10 ? Math.round(v) : Number(v.toFixed(2))}/min`
}

/** Format a signed net rate with an explicit +/- sign. */
function perMinNet(v: number): string {
  const abs = Math.abs(v)
  const body = abs >= 10 ? Math.round(abs) : Number(abs.toFixed(2))
  const sign = v > 0 ? '+' : v < 0 ? '−' : ''
  return `${sign}${body}/min`
}

const WINDOWS: readonly { readonly key: StatsWindow; readonly label: string }[] = [
  { key: 'fine', label: '1 min' },
  { key: 'medium', label: '5 min' },
  { key: 'coarse', label: '15 min' },
]

const TREND_ICON: Record<Trend, IconName> = {
  up: 'TrendingUp',
  down: 'TrendingDown',
  flat: 'Minus',
}
const TREND_CLASS: Record<Trend, string> = { up: 'good', down: 'bad', flat: '' }

type SortKey = 'name' | 'produced' | 'consumed' | 'net'

/** One P-screen table row: a resource's window-averaged rates plus its net trend. */
interface StatRow {
  readonly color: number
  readonly name: string
  readonly producedPerMin: number
  readonly consumedPerMin: number
  readonly net: number
  readonly trend: Trend
}

/** Build one row per resource ever sampled this session, averaged over the selected window. The
 * trend arrow reads the *net* (produced − consumed) series so it reflects whether the resource's
 * balance is improving or worsening, not just whether production alone is rising. */
function buildRows(window: StatsWindow): StatRow[] {
  const rows: StatRow[] = []
  for (const color of statsHistory.colors()) {
    const produced = statsHistory.producedSeries(color, window)
    const consumed = statsHistory.consumedSeries(color, window)
    const producedPerMin = mean(produced) * 60
    const consumedPerMin = mean(consumed) * 60
    const n = Math.min(produced.length, consumed.length)
    const net: number[] = new Array(n)
    for (let i = 0; i < n; i++) net[i] = produced[i]! - consumed[i]!
    rows.push({
      color,
      name: resourceByColor(color)?.name ?? `0x${color.toString(16).padStart(6, '0')}`,
      producedPerMin,
      consumedPerMin,
      net: producedPerMin - consumedPerMin,
      trend: trendDirection(net),
    })
  }
  return rows
}

function sortRows(rows: readonly StatRow[], key: SortKey, dir: 'asc' | 'desc'): StatRow[] {
  const sign = dir === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    switch (key) {
      case 'name':
        return a.name.localeCompare(b.name) * sign
      case 'produced':
        return (a.producedPerMin - b.producedPerMin) * sign
      case 'consumed':
        return (a.consumedPerMin - b.consumedPerMin) * sign
      case 'net':
        return (a.net - b.net) * sign
    }
  })
}

/** A sortable column header: clicking toggles direction, or switches column (numeric columns
 * default to descending — biggest first reads naturally; the name column defaults ascending). */
function SortHeader({
  label,
  col,
  align = 'right',
  sortKey,
  sortDir,
  onSort,
}: {
  label: string
  col: SortKey
  align?: 'left' | 'right'
  sortKey: SortKey
  sortDir: 'asc' | 'desc'
  onSort: (col: SortKey) => void
}): React.JSX.Element {
  const active = sortKey === col
  return (
    <th className={`stats-th${align === 'left' ? ' stats-th-left' : ''}`}>
      <button className="stats-th-btn" onClick={() => onSort(col)}>
        {label}
        {active && <Icon name={sortDir === 'asc' ? 'ChevronUp' : 'ChevronDown'} size={11} />}
      </button>
    </th>
  )
}

/** A bigger line chart of one resource's produced vs. consumed series over the selected window —
 * the sparkline approach from the HUD panel scaled up, still a hand-rolled SVG polyline pair. */
function StatChart({ color, window }: { color: number; window: StatsWindow }): React.JSX.Element {
  const produced = statsHistory.producedSeries(color, window)
  const consumed = statsHistory.consumedSeries(color, window)
  const w = 640
  const h = 180
  const max = Math.max(1, ...produced, ...consumed)
  const line = (series: readonly number[]): string => {
    const n = series.length
    if (n < 2) return `0,${h} ${w},${h}`
    return series
      .map(
        (v, i) => `${((i / (n - 1)) * w).toFixed(1)},${(h - (v / max) * (h - 6) - 3).toFixed(1)}`,
      )
      .join(' ')
  }
  return (
    <div className="stats-chart-wrap">
      <svg
        className="stats-chart"
        width={w}
        height={h}
        viewBox={`0 0 ${w} ${h}`}
        aria-hidden="true"
      >
        <polyline points={line(consumed)} fill="none" stroke="var(--bad)" strokeWidth="1.5" />
        <polyline points={line(produced)} fill="none" stroke={cssColor(color)} strokeWidth="2" />
      </svg>
      <div className="stats-chart-legend">
        <span className="stats-legend-item">
          <span className="stats-swatch" style={{ background: cssColor(color) }} />
          Production
        </span>
        <span className="stats-legend-item">
          <span className="stats-swatch stats-swatch-bad" />
          Consumption
        </span>
      </div>
    </div>
  )
}

/** One table row: the resource's averaged rates, plus its net and trend. Clicking it expands an
 * inline detail row with the larger two-series chart (only one row expands at a time). */
function StatTableRow({
  row,
  window,
  expanded,
  onToggle,
}: {
  row: StatRow
  window: StatsWindow
  expanded: boolean
  onToggle: () => void
}): React.JSX.Element {
  return (
    <>
      <tr className={`stats-row${expanded ? ' expanded' : ''}`} onClick={onToggle}>
        <td className="stats-td-icon">
          <ResourceLabel color={row.color} showName={false} size={16} />
        </td>
        <td className="stats-td-name">{row.name}</td>
        <td className="stats-td-num">{perMinRate(row.producedPerMin)}</td>
        <td className="stats-td-num">{perMinRate(row.consumedPerMin)}</td>
        <td className={`stats-td-num${row.net > 0 ? ' good' : row.net < 0 ? ' bad' : ''}`}>
          {perMinNet(row.net)}
        </td>
        <td className={`stats-td-trend ${TREND_CLASS[row.trend]}`}>
          <Icon name={TREND_ICON[row.trend]} size={14} />
        </td>
      </tr>
      {expanded && (
        <tr className="stats-detail-row">
          <td colSpan={6}>
            <StatChart color={row.color} window={window} />
          </td>
        </tr>
      )}
    </>
  )
}

/**
 * The full production statistics dashboard ("P-screen"): every resource ever produced or consumed
 * this session, with production/consumption/net per minute averaged over a selectable window and a
 * trend arrow, sortable and text-filterable. Clicking a row expands a larger two-series chart of
 * that resource's history over the same window. Opened with the `P` key or the HUD button; reads
 * only {@link statsHistory} (itself fed read-only production/consumption rates from the sim via
 * `productionFlows`, see main.tsx) — never touches sim state. The sim keeps running while this is
 * open: it is a live dashboard, not a paused inspector, matching the always-live HUD sparklines it
 * promotes.
 */
export function StatsScreen(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [win, setWin] = useState<StatsWindow>('fine')
  const [query, setQuery] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('produced')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [expanded, setExpanded] = useState<number | null>(null)

  // Re-render on every fresh sample so the table/chart track the live production rates.
  const version = useSyncExternalStore(
    statsHistory.subscribe,
    statsHistory.getVersion,
    statsHistory.getVersion,
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
      if (e.key === 'p' || e.key === 'P') {
        e.preventDefault()
        setOpen((v) => !v)
      } else if (e.key === 'Escape' && open) {
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const onSort = (col: SortKey): void => {
    if (sortKey === col) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(col)
      setSortDir(col === 'name' ? 'asc' : 'desc')
    }
  }

  const q = query.trim().toLowerCase()
  // `version` isn't read in the body but forces the memo to recompute whenever statsHistory gets a
  // fresh sample (win/q/sort alone wouldn't change between pushes).
  const rows = useMemo(() => {
    const all = buildRows(win)
    const filtered = q ? all.filter((r) => r.name.toLowerCase().includes(q)) : all
    return sortRows(filtered, sortKey, sortDir)
  }, [win, q, sortKey, sortDir, version])

  return (
    <>
      {open && (
        <div className="stats-modal-backdrop" onClick={() => setOpen(false)}>
          <div
            className="stats-modal glass"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="Production statistics"
          >
            <div className="stats-head">
              <Icon name="ChartLine" size={16} />
              <span className="stats-title">Production Statistics</span>
              <div className="stats-windows">
                {WINDOWS.map((w) => (
                  <button
                    key={w.key}
                    className={`stats-window-btn${win === w.key ? ' active' : ''}`}
                    onClick={() => setWin(w.key)}
                  >
                    {w.label}
                  </button>
                ))}
              </div>
              <div className="enc-search">
                <Icon name="Search" size={14} />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Filter resources…"
                  aria-label="Filter resources"
                />
              </div>
              <button
                className="sidebar-close"
                onClick={() => setOpen(false)}
                aria-label="Close statistics"
              >
                ×
              </button>
            </div>

            {rows.length === 0 ? (
              <div className="stats-empty">No production yet — build some crafters.</div>
            ) : (
              <div className="stats-table-wrap">
                <table className="stats-table">
                  <thead>
                    <tr>
                      <th className="stats-th" />
                      <SortHeader
                        label="Resource"
                        col="name"
                        align="left"
                        sortKey={sortKey}
                        sortDir={sortDir}
                        onSort={onSort}
                      />
                      <SortHeader
                        label="Production/min"
                        col="produced"
                        sortKey={sortKey}
                        sortDir={sortDir}
                        onSort={onSort}
                      />
                      <SortHeader
                        label="Consumption/min"
                        col="consumed"
                        sortKey={sortKey}
                        sortDir={sortDir}
                        onSort={onSort}
                      />
                      <SortHeader
                        label="Net/min"
                        col="net"
                        sortKey={sortKey}
                        sortDir={sortDir}
                        onSort={onSort}
                      />
                      <th className="stats-th">Trend</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <StatTableRow
                        key={r.color}
                        row={r}
                        window={win}
                        expanded={expanded === r.color}
                        onToggle={() => setExpanded((c) => (c === r.color ? null : r.color))}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
      <button
        className="stats-btn glass"
        onClick={() => setOpen((v) => !v)}
        title="Production statistics (P)"
        aria-label="Production statistics"
        aria-pressed={open}
      >
        <Icon name="ChartLine" size={16} />
        <span>Stats</span>
      </button>
    </>
  )
}
