import { useSyncExternalStore } from 'react'
import { saveStore } from './saveStore.ts'
import { victoryStore } from './victoryStore.ts'
import { SimControls } from './SimControls.tsx'
import { Icon } from './Icon.tsx'

/**
 * The always-visible player control bar (top-left): playback controls, the Saves button, and — once
 * the scenario goal is reached — a persistent "Victory" badge (G5) that reopens the win screen.
 * This is the player-facing counterpart to the F3 {@link import('./DebugOverlay.tsx').DebugOverlay}.
 * Owns no state; the sim controls read their own store and the buttons drive their controllers.
 */
export function TopBar(): React.JSX.Element {
  const victory = useSyncExternalStore(victoryStore.subscribe, victoryStore.get, victoryStore.get)
  return (
    <div className="topbar glass">
      <SimControls />
      <span className="topbar-divider" />
      <button
        className="topbar-btn"
        onClick={() => saveStore.getController()?.open()}
        title="Saves (F10)"
        aria-label="Saves"
      >
        <Icon name="Save" size={16} />
        <span>Saves</span>
      </button>
      {victory.won && (
        <>
          <span className="topbar-divider" />
          <button
            className="topbar-badge"
            onClick={() => victoryStore.set({ modalOpen: true })}
            title="You reached the scenario goal — view the summary"
            aria-label="Victory summary"
          >
            <span aria-hidden="true">🏆</span>
            <span>Victory</span>
          </button>
        </>
      )}
    </div>
  )
}
