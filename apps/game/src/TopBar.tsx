import { saveStore } from './saveStore.ts'
import { SimControls } from './SimControls.tsx'
import { Icon } from './Icon.tsx'

/**
 * The always-visible player control bar (top-left): playback controls plus the Saves button.
 * This is the player-facing counterpart to the F3 {@link import('./DebugOverlay.tsx').DebugOverlay}
 * — the two were previously merged into one "Factory — Debug" panel. Owns no state; the sim
 * controls read their own store and the Saves button opens the save menu via its controller.
 */
export function TopBar(): React.JSX.Element {
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
    </div>
  )
}
