import { useSyncExternalStore } from 'react'
import { buildStore } from './buildStore.ts'

/** 0xRRGGBB packed color -> CSS hex string. */
function cssColor(color: number): string {
  return `#${(color >>> 0).toString(16).padStart(6, '0')}`
}

/**
 * Bottom toolbar of placeable buildings. Selecting a tool arms placement (handled
 * by `placement.ts`); clicking the selected tool again disarms it. Reads the build
 * store; it never touches the sim.
 */
export function BuildBar(): React.JSX.Element | null {
  const state = useSyncExternalStore(buildStore.subscribe, buildStore.get, buildStore.get)
  if (state.items.length === 0) return null

  const selected = state.selected ? state.items.find((i) => i.id === state.selected) : null
  const hint =
    selected?.kind === 'belt'
      ? 'Drag from the start tile to the end tile'
      : selected?.kind === 'port'
        ? 'Click a belt tile to attach this port'
        : selected?.kind === 'splitter'
          ? 'Click a belt tile to place this splitter'
          : selected?.kind === 'producer'
            ? 'Click a belt tile to place this building'
            : selected
              ? 'Click a tile to place'
              : 'Pick a building to build'

  return (
    <div className="buildbar">
      <div className="buildbar-tools">
        {state.items.map((item) => (
          <button
            key={item.id}
            className={`tool${state.selected === item.id ? ' selected' : ''}`}
            onClick={() => buildStore.toggle(item.id)}
            title={item.name}
          >
            <span className="swatch" style={{ background: cssColor(item.color) }} />
            <span className="tool-name">{item.name}</span>
          </button>
        ))}
      </div>
      <div className="buildbar-hint">{hint}</div>
    </div>
  )
}
