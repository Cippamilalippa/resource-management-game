import { useEffect, useState, useSyncExternalStore } from 'react'
import { statsStore } from './statsStore.ts'

/**
 * Developer stats overlay (tick / entities / prototypes / FPS / mods), read from {@link statsStore}.
 * Hidden by default and toggled with F3 so it never clutters the player-facing HUD. Purely a
 * read-out — it never touches the sim. Keypresses are ignored while typing in a field.
 */
export function DebugOverlay(): React.JSX.Element | null {
  const stats = useSyncExternalStore(statsStore.subscribe, statsStore.get, statsStore.get)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
      if (e.key === 'F3') {
        e.preventDefault()
        setOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!open) return null

  return (
    <div className="debug-overlay glass">
      <h1 className="debug-title">Debug · F3</h1>
      <div className="debug-row">
        <span>Tick</span>
        <span className="debug-value">{stats.tick.toLocaleString()}</span>
      </div>
      <div className="debug-row">
        <span>Entities</span>
        <span className="debug-value">{stats.entities.toLocaleString()}</span>
      </div>
      <div className="debug-row">
        <span>Prototypes</span>
        <span className="debug-value">{stats.prototypes.toLocaleString()}</span>
      </div>
      <div className="debug-row">
        <span>FPS</span>
        <span className="debug-value">{stats.fps}</span>
      </div>
      <div className="debug-row">
        <span>Mods</span>
        <span className="debug-value">{stats.mods}</span>
      </div>
    </div>
  )
}
