import { useState, useSyncExternalStore } from 'react'
import { appStore } from './appStore.ts'
import { saveStore } from './saveStore.ts'

/** A random uint32 seed for the "Randomize" button. Host UI only — not sim code, so `Math.random`
 * is fine here (the value only *seeds* the deterministic sim RNG). */
function randomSeed(): number {
  return Math.floor(Math.random() * 0xffffffff) >>> 0
}

/** Parse the seed field to a uint32, or null if it isn't a non-negative integer. */
function parseSeed(text: string): number | null {
  const t = text.trim()
  if (!/^\d+$/.test(t)) return null
  const n = Number(t)
  return Number.isFinite(n) ? n >>> 0 : null
}

/**
 * The new-game setup screen: pick a seed (typed or randomized) and a starting scenario, then start.
 * Reads the scenario list from {@link appStore} and drives the boot-loop controller. Rendered only
 * while `phase === 'setup'`. The same seed + scenario always produce the same starting world.
 */
export function NewGameSetup(): React.JSX.Element | null {
  const app = useSyncExternalStore(appStore.subscribe, appStore.get, appStore.get)
  const save = useSyncExternalStore(saveStore.subscribe, saveStore.get, saveStore.get)
  const controller = appStore.getController()
  const [seedText, setSeedText] = useState(() => String(randomSeed()))
  const [scenario, setScenario] = useState('')

  if (app.phase !== 'setup') return null

  const scenarios = app.scenarios
  const selected = scenario || scenarios[0]?.id || ''
  const seed = parseSeed(seedText)
  const canStart = seed !== null && selected !== '' && !save.busy

  const start = (): void => {
    if (seed === null || selected === '') return
    void controller?.startNew(seed, selected)
  }

  return (
    <div className="menu-screen">
      <div className="menu-card menu-card-wide">
        <div className="menu-head">
          <h1 className="menu-title">New Game</h1>
          <button className="sidebar-close" onClick={() => controller?.backToMenu()}>
            ×
          </button>
        </div>

        <label className="setup-label">Seed</label>
        <div className="setup-seed">
          <input
            className="save-input"
            value={seedText}
            inputMode="numeric"
            maxLength={10}
            onChange={(e) => setSeedText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canStart) start()
            }}
          />
          <button className="save-btn" onClick={() => setSeedText(String(randomSeed()))}>
            Randomize
          </button>
        </div>
        {seed === null && (
          <div className="setup-hint">Seed must be a non-negative whole number.</div>
        )}

        <label className="setup-label">Scenario</label>
        <ul className="setup-scenarios">
          {scenarios.map((s) => (
            <li key={s.id}>
              <button
                className={`setup-scenario${selected === s.id ? ' selected' : ''}`}
                onClick={() => setScenario(s.id)}
              >
                <span className="setup-scenario-name">{s.name}</span>
                <span className="setup-scenario-info">{s.info}</span>
              </button>
            </li>
          ))}
        </ul>

        <div className="setup-actions">
          <button className="save-btn" onClick={() => controller?.backToMenu()}>
            Back
          </button>
          <button className="save-btn save-btn-primary" disabled={!canStart} onClick={start}>
            Start
          </button>
        </div>
      </div>
    </div>
  )
}
