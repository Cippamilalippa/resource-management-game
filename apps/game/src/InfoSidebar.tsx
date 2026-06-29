import { useSyncExternalStore } from 'react'
import { inspectStore } from './inspectStore.ts'
import type { InspectStat } from './inspect.ts'

/** 0xRRGGBB packed color -> CSS hex string. */
function cssColor(color: number): string {
  return `#${(color >>> 0).toString(16).padStart(6, '0')}`
}

/** Render one declarative info row by its kind (text / colour swatch / progress bar). */
function StatRow({ stat }: { stat: InspectStat }): React.JSX.Element {
  return (
    <div className="sidebar-row">
      <span className="sidebar-label">{stat.label}</span>
      {stat.kind === 'text' && <span className="sidebar-value">{stat.value}</span>}
      {stat.kind === 'color' && (
        <span className="sidebar-value">
          <span className="sidebar-swatch" style={{ background: cssColor(stat.color) }} />
        </span>
      )}
      {stat.kind === 'bar' && (
        <span className="sidebar-value sidebar-barwrap">
          <span className="sidebar-bartext">
            {stat.value}/{stat.max}
          </span>
          <span className="sidebar-bar">
            <span
              className="sidebar-barfill"
              style={{
                width: `${stat.max > 0 ? Math.min(100, (stat.value / stat.max) * 100) : 0}%`,
                ...(stat.color !== undefined ? { background: cssColor(stat.color) } : {}),
              }}
            />
          </span>
        </span>
      )}
    </div>
  )
}

/**
 * Right-hand inspector panel. Shows the object under the cursor (hover) or the pinned one
 * (after a click). Reads the inspect store; it never touches the sim. Hidden when nothing
 * is under the cursor and nothing is pinned.
 */
export function InfoSidebar(): React.JSX.Element | null {
  const state = useSyncExternalStore(inspectStore.subscribe, inspectStore.get, inspectStore.get)
  const info = state.info
  if (!info) return null

  return (
    <div className="sidebar">
      <div className="sidebar-head">
        <span className="sidebar-accent" style={{ background: cssColor(info.color) }} />
        <div className="sidebar-titles">
          <h2 className="sidebar-title">{info.title}</h2>
          <span className="sidebar-subtitle">{info.subtitle}</span>
        </div>
        {state.pinned && (
          <button className="sidebar-close" title="Unpin" onClick={() => inspectStore.unpin()}>
            ×
          </button>
        )}
      </div>
      <div className="sidebar-stats">
        {info.stats.map((stat, i) => (
          <StatRow key={`${stat.label}-${i}`} stat={stat} />
        ))}
      </div>
      <div className="sidebar-foot">
        {state.pinned ? 'Pinned — click again to release' : 'Click to pin'}
      </div>
    </div>
  )
}
