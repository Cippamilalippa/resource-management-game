import { useState, useSyncExternalStore } from 'react'
import { SNAPSHOT_VERSION } from '@factory/engine/persistence'
import { saveStore } from './saveStore.ts'
import type { SaveMeta } from '../electron/preload.ts'

/** Human label for a slot's origin, shown as a small badge. */
const KIND_LABEL: Record<SaveMeta['kind'], string> = {
  manual: 'Save',
  quick: 'Quick',
  auto: 'Auto',
}

/** Format an epoch-ms timestamp as a short local date+time for the slot card. */
function when(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** One save slot row: metadata plus load/overwrite/delete actions. */
function SaveRow({
  meta,
  active,
  busy,
  onLoad,
  onOverwrite,
  onDelete,
}: {
  meta: SaveMeta
  active: boolean
  busy: boolean
  onLoad: () => void
  onOverwrite: () => void
  onDelete: () => void
}): React.JSX.Element {
  // A save from a different engine snapshot version can't be restored by this build.
  const incompatible = meta.snapshotVersion !== SNAPSHOT_VERSION
  return (
    <li className={`save-row${active ? ' active' : ''}`}>
      <div className="save-row-main">
        <span className={`save-badge save-badge-${meta.kind}`}>{KIND_LABEL[meta.kind]}</span>
        <div className="save-row-titles">
          <span className="save-row-name">{meta.name}</span>
          <span className="save-row-meta">
            tick {meta.tick.toLocaleString()} · {when(meta.updatedAt)}
            {incompatible ? ` · v${meta.snapshotVersion} (incompatible)` : ''}
          </span>
        </div>
      </div>
      <div className="save-row-actions">
        <button className="save-btn" disabled={busy || incompatible} onClick={onLoad}>
          Load
        </button>
        {meta.kind === 'manual' && (
          <button className="save-btn" disabled={busy} onClick={onOverwrite}>
            Overwrite
          </button>
        )}
        <button className="save-btn save-btn-danger" disabled={busy} onClick={onDelete}>
          ✕
        </button>
      </div>
    </li>
  )
}

/**
 * The save/load overlay: a modal list of every slot with quicksave/new-game/named-save actions,
 * plus a corner toast for transient confirmations. Reads {@link saveStore} and drives the
 * boot-loop controller registered on it. Opened with Esc (see main.tsx); the sim pauses while open.
 */
export function SaveMenu(): React.JSX.Element | null {
  const state = useSyncExternalStore(saveStore.subscribe, saveStore.get, saveStore.get)
  const [name, setName] = useState('')
  const controller = saveStore.getController()

  const toast = state.toast ? <div className="save-toast">{state.toast}</div> : null
  if (!state.open) return toast

  const unavailable = !controller || !window.factory
  const submitNew = (): void => {
    const trimmed = name.trim()
    if (!trimmed || !controller) return
    void controller.saveNew(trimmed)
    setName('')
  }

  return (
    <>
      {toast}
      <div className="save-modal-backdrop" onClick={() => controller?.close()}>
        <div className="save-modal" onClick={(e) => e.stopPropagation()}>
          <div className="save-modal-head">
            <h2>Saved Games</h2>
            <button className="sidebar-close" onClick={() => controller?.close()}>
              ×
            </button>
          </div>

          {unavailable ? (
            <p className="save-unavailable">
              Saving is only available in the desktop app (no Electron bridge here).
            </p>
          ) : (
            <>
              <div className="save-actions">
                <button
                  className="save-btn save-btn-primary"
                  disabled={state.busy}
                  onClick={() => void controller?.quickSave()}
                >
                  Quicksave
                </button>
                <button
                  className="save-btn"
                  disabled={state.busy}
                  onClick={() => void controller?.newGame()}
                >
                  New Game
                </button>
                <div className="save-new">
                  <input
                    className="save-input"
                    placeholder="Name a new save…"
                    value={name}
                    maxLength={60}
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') submitNew()
                    }}
                  />
                  <button
                    className="save-btn save-btn-primary"
                    disabled={state.busy || name.trim() === ''}
                    onClick={submitNew}
                  >
                    Save
                  </button>
                </div>
              </div>

              {state.error && <div className="save-error">{state.error}</div>}

              {state.saves.length === 0 ? (
                <p className="save-empty">No saved games yet.</p>
              ) : (
                <ul className="save-list">
                  {state.saves.map((meta) => (
                    <SaveRow
                      key={meta.id}
                      meta={meta}
                      active={state.activeId === meta.id}
                      busy={state.busy}
                      onLoad={() => void controller?.load(meta)}
                      onOverwrite={() => void controller?.overwrite(meta)}
                      onDelete={() => void controller?.remove(meta)}
                    />
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </div>
    </>
  )
}
