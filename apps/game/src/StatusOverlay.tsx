import { useEffect, useSyncExternalStore } from 'react'
import { overlayStore } from './overlayStore.ts'
import { Icon } from './Icon.tsx'

/**
 * Floating toggle for the on-map status overlay (also on the `V` key): highlights every trouble
 * spot — starved crafters, backed-up outputs, declining villages — directly on the map so problems
 * read at a glance. Purely a view toggle; the renderer draws the marks from the read-only HUD
 * selectors and never mutates the sim.
 */
export function StatusOverlay(): React.JSX.Element {
  const { on } = useSyncExternalStore(overlayStore.subscribe, overlayStore.get, overlayStore.get)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
      if (e.key === 'v' || e.key === 'V') {
        e.preventDefault()
        overlayStore.toggle()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <button
      className={`overlay-btn glass${on ? ' active' : ''}`}
      onClick={() => overlayStore.toggle()}
      title="Status overlay (V)"
      aria-label="Status overlay"
      aria-pressed={on}
    >
      <Icon name="Radar" size={16} />
      <span>Status</span>
    </button>
  )
}
