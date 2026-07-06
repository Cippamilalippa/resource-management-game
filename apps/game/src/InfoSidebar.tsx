import { useSyncExternalStore } from 'react'
import { inspectStore } from './inspectStore.ts'
import type { InspectStat } from './inspect.ts'
import { ResourceLabel } from './ResourceLabel.tsx'
import { RecipePanel } from './RecipePanel.tsx'
import { FilterPanel } from './FilterPanel.tsx'
import { encyclopediaStore } from './encyclopedia.ts'

/** 0xRRGGBB packed color -> CSS hex string. */
function cssColor(color: number): string {
  return `#${(color >>> 0).toString(16).padStart(6, '0')}`
}

/** Render one declarative info row by its kind (heading / text / colour swatch / progress bar). */
function StatRow({ stat }: { stat: InspectStat }): React.JSX.Element {
  // A heading is a section title spanning the row (e.g. "Produces" / "Consumes").
  if (stat.kind === 'heading') {
    return <div className="sidebar-heading">{stat.label}</div>
  }
  // Hoisted so the click handlers below don't need a non-null assertion on the union-narrowed field.
  const barColor = stat.kind === 'bar' ? stat.color : undefined
  const openItem = (color: number): void => encyclopediaStore.openForItem(color)
  return (
    <div className="sidebar-row">
      {/* A resource bar is labelled by the resource's icon; other rows by their text label. Clicking
          it opens the encyclopedia filtered on that item (Q4) — these are the accepts/produces rows. */}
      {barColor !== undefined ? (
        <span className="sidebar-label">
          <ResourceLabel color={barColor} showName={false} onClick={() => openItem(barColor)} />
        </span>
      ) : (
        <span className="sidebar-label">{stat.label}</span>
      )}
      {stat.kind === 'text' && <span className="sidebar-value">{stat.value}</span>}
      {stat.kind === 'color' && (
        <span className="sidebar-value">
          <ResourceLabel color={stat.color} onClick={() => openItem(stat.color)} />
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
          {stat.rate !== undefined && <span className="sidebar-barrate">{stat.rate}</span>}
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
      {/* Recipe picker for a pinned crafter (self-hides when the selection isn't a crafter). */}
      <RecipePanel />
      {/* Colour-filter editor for a pinned input/output port (self-hides otherwise). */}
      <FilterPanel />
      <div className="sidebar-foot">
        {state.pinned ? 'Pinned — click again to release' : 'Click to pin'}
      </div>
    </div>
  )
}
