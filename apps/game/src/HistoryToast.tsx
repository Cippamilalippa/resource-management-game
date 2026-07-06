import { useSyncExternalStore } from 'react'
import { historyStore } from './historyStore.ts'

/**
 * Undo/redo visibility (Q5): a transient toast naming the step Ctrl+Z/Ctrl+Shift+Z just
 * touched ("Undid: Belt — 4 more"), plus a small hoverable badge listing the last few steps so the
 * otherwise-invisible history stack has some presence on screen. Read-only over {@link historyStore};
 * never touches the sim. Renders nothing once there's neither a toast nor any history yet.
 */
export function HistoryToast(): React.JSX.Element | null {
  const view = useSyncExternalStore(historyStore.subscribe, historyStore.get, historyStore.get)
  if (!view.toast && view.recentLabels.length === 0) return null

  return (
    <div className="history-hud">
      {view.recentLabels.length > 0 && (
        <div className="history-panel-wrap" tabIndex={0} aria-label="Undo history">
          <span className="history-badge glass">{view.recentLabels.length}</span>
          <div className="history-panel glass" role="tooltip">
            <div className="history-panel-head">Recent steps</div>
            <ul className="history-panel-list">
              {view.recentLabels.map((label, i) => (
                <li key={i}>{label}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {view.toast && <div className="history-toast glass">{view.toast}</div>}
    </div>
  )
}
