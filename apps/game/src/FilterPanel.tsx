import { useState, useSyncExternalStore } from 'react'
import { filterStore, type FilterSelection } from './filterStore.ts'
import { allResources } from './resources.ts'
import { ResourceLabel } from './ResourceLabel.tsx'
import { FILTER_NONE, FILTER_WHITELIST, FILTER_BLACKLIST, MAX_PORT_FILTER } from './gameLogic.ts'

/** The three filter modes, in the order shown as a segmented control. */
const MODES: readonly { readonly mode: number; readonly label: string }[] = [
  { mode: FILTER_NONE, label: 'All' },
  { mode: FILTER_WHITELIST, label: 'Only these' },
  { mode: FILTER_BLACKLIST, label: 'All but these' },
]

/**
 * The editor body for one pinned port. Local state is seeded from the store once (the parent keys
 * this by tile, so it remounts — re-seeding — when a different port is pinned) and drives the UI
 * optimistically; every change also enqueues a `set_port_filter` through the controller. Choosing
 * "All" clears the colour list; whitelist/blacklist toggle up to {@link MAX_PORT_FILTER} colours.
 */
function FilterEditor({ sel }: { sel: FilterSelection }): React.JSX.Element {
  const [mode, setMode] = useState(sel.mode)
  const [colors, setColors] = useState<readonly number[]>(sel.colors)

  const apply = (m: number, c: readonly number[]): void => {
    setMode(m)
    setColors(c)
    filterStore.getController()?.set(m, c)
  }
  const chooseMode = (m: number): void => apply(m, m === FILTER_NONE ? [] : colors)
  const toggle = (color: number): void => {
    if (colors.includes(color))
      apply(
        mode,
        colors.filter((c) => c !== color),
      )
    else if (colors.length < MAX_PORT_FILTER) apply(mode, [...colors, color])
  }

  const active = mode !== FILTER_NONE
  const verb = sel.port === 'output' ? 'Drains' : 'Accepts'
  return (
    <div className="recipe-picker">
      <div className="recipe-head">Filter · {sel.port} port</div>
      <div className="filter-modes">
        {MODES.map((m) => (
          <button
            key={m.mode}
            className={`filter-mode${mode === m.mode ? ' active' : ''}`}
            onClick={() => chooseMode(m.mode)}
          >
            {m.label}
          </button>
        ))}
      </div>
      {active ? (
        <>
          <div className="filter-items">
            {allResources().map((r) => {
              const on = colors.includes(r.color)
              const full = !on && colors.length >= MAX_PORT_FILTER
              return (
                <button
                  key={r.color}
                  className={`filter-item${on ? ' active' : ''}`}
                  disabled={full}
                  onClick={() => toggle(r.color)}
                  title={r.name}
                >
                  <ResourceLabel color={r.color} size={14} showName={false} />
                </button>
              )
            })}
          </div>
          <div className="filter-hint">
            {verb} {mode === FILTER_WHITELIST ? 'only' : 'everything except'} the {colors.length}{' '}
            selected ({colors.length}/{MAX_PORT_FILTER})
          </div>
        </>
      ) : (
        <div className="recipe-empty">{verb} every resource. Pick a mode to filter by colour.</div>
      )}
    </div>
  )
}

/**
 * Colour-filter editor for a pinned input/output port, rendered inside the inspector sidebar. Reads
 * {@link filterStore} (populated by `placement.ts` when a port is pinned) and enqueues a
 * `set_port_filter` through the wired controller. Renders nothing when no port is pinned.
 */
export function FilterPanel(): React.JSX.Element | null {
  const sel = useSyncExternalStore(filterStore.subscribe, filterStore.get, filterStore.get)
  if (!sel) return null
  return <FilterEditor key={`${sel.x},${sel.y}`} sel={sel} />
}
