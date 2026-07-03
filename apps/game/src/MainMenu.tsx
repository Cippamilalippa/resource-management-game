import { useSyncExternalStore } from 'react'
import { appStore } from './appStore.ts'
import { saveStore } from './saveStore.ts'

/**
 * The main menu shell shown at boot (and whenever the player returns to it): New Game / Continue /
 * Load / Quit. Reads {@link appStore} for phase + save availability and drives the boot-loop
 * {@link import('./appStore.ts').AppController}. Continue/Load are disabled until a save exists;
 * Quit is hidden outside the desktop app. Rendered only while `phase === 'menu'`.
 */
export function MainMenu(): React.JSX.Element | null {
  const app = useSyncExternalStore(appStore.subscribe, appStore.get, appStore.get)
  const save = useSyncExternalStore(saveStore.subscribe, saveStore.get, saveStore.get)
  const controller = appStore.getController()
  if (app.phase !== 'menu') return null

  const busy = save.busy
  return (
    <div className="menu-screen">
      <div className="menu-card">
        <h1 className="menu-title">Factory</h1>
        <p className="menu-subtitle">Build · Automate · Research · Grow</p>
        <div className="menu-actions">
          <button
            className="menu-item menu-item-primary"
            disabled={busy}
            onClick={() => controller?.showSetup()}
          >
            New Game
          </button>
          <button
            className="menu-item"
            disabled={busy || !app.hasSaves}
            onClick={() => void controller?.continueGame()}
          >
            Continue
          </button>
          <button
            className="menu-item"
            disabled={busy || !app.hasSaves}
            onClick={() => controller?.openLoad()}
          >
            Load Game
          </button>
          {!app.unavailable && (
            <button className="menu-item" disabled={busy} onClick={() => controller?.quit()}>
              Quit
            </button>
          )}
        </div>
        {app.unavailable && (
          <p className="menu-note">
            Running in a browser — saving and quitting need the desktop app.
          </p>
        )}
        {save.error && <div className="save-error">{save.error}</div>}
      </div>
    </div>
  )
}
