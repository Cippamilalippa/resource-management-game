import { useSyncExternalStore } from 'react'
import { victoryStore } from './victoryStore.ts'
import { appStore } from './appStore.ts'
import { useModal } from './modalStore.ts'

/** Format seconds as `h:mm:ss` (or `m:ss` under an hour) for the win-screen play-time stat. */
function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`
}

/** One headline stat tile (a big value over a small label). */
function Stat({ value, label }: { value: string; label: string }): React.JSX.Element {
  return (
    <div className="victory-stat">
      <span className="victory-stat-value">{value}</span>
      <span className="victory-stat-label">{label}</span>
    </div>
  )
}

/**
 * The G5 win screen: a celebratory glass modal (SaveMenu-style backdrop) shown the first time the
 * scenario goal is reached this session. Headline plus a stat grid — play time, sim ticks, techs
 * researched, per-settlement levels and a cheap production headline — and two actions: keep playing
 * (dismiss; the TopBar badge remains) or drop to the main menu. Read-only: it drives the app
 * controller and the victory store, never the sim.
 */
export function VictoryScreen(): React.JSX.Element | null {
  const victory = useSyncExternalStore(victoryStore.subscribe, victoryStore.get, victoryStore.get)
  // Esc dismisses the win screen (keep playing) via the central modal stack (modalStore). Registered
  // before the early return so the hook order stays stable.
  useModal('victory', victory.modalOpen, () => victoryStore.set({ modalOpen: false }))
  if (!victory.modalOpen || victory.stats === null) return null
  const s = victory.stats

  const dismiss = (): void => victoryStore.set({ modalOpen: false })
  const toMenu = (): void => {
    victoryStore.set({ modalOpen: false })
    void appStore.getController()?.backToMenu()
  }

  return (
    <div className="victory-backdrop" onClick={dismiss}>
      <div
        className="victory-modal glass"
        role="dialog"
        aria-modal="true"
        aria-label="Victory"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="victory-head">
          <span className="victory-crown" aria-hidden="true">
            🏆
          </span>
          <h2 className="victory-title">Victory!</h2>
          <p className="victory-sub">
            {s.goalName} reached level {s.goalStage + 1} — you built the colony.
          </p>
        </div>

        <div className="victory-stats">
          <Stat value={formatDuration(s.playTimeSec)} label="Play time" />
          <Stat value={s.ticks.toLocaleString()} label="Sim ticks" />
          <Stat value={String(s.techNames.length)} label="Techs researched" />
          <Stat value={String(s.machineCount)} label="Machines built" />
          <Stat value={`${s.totalProducedPerSec.toFixed(1)}/s`} label="Production" />
        </div>

        <div className="victory-section">
          <h3 className="victory-section-head">Settlements</h3>
          <ul className="victory-list">
            {s.settlements.map((v, i) => (
              <li key={i} className="victory-list-row">
                <span className="victory-list-name">{v.name}</span>
                <span className="victory-list-value">
                  Level {v.level}
                  <span className="victory-list-max"> / {v.maxLevel}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="victory-section">
          <h3 className="victory-section-head">
            Technologies <span className="victory-count">{s.techNames.length}</span>
          </h3>
          {s.techNames.length > 0 ? (
            <div className="victory-techs">
              {s.techNames.map((name, i) => (
                <span key={i} className="victory-tech-chip">
                  {name}
                </span>
              ))}
            </div>
          ) : (
            <p className="victory-empty">No technologies researched.</p>
          )}
        </div>

        <div className="victory-actions">
          <button className="victory-btn victory-btn-primary" onClick={dismiss}>
            Continue playing
          </button>
          <button className="victory-btn" onClick={toMenu}>
            Main menu
          </button>
        </div>
      </div>
    </div>
  )
}
