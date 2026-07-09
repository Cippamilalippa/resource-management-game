import { useEffect, useSyncExternalStore } from 'react'
import { mapModeStore } from './mapModeStore.ts'
import { appStore } from './appStore.ts'
import { Icon } from './Icon.tsx'
import { useModal } from './modalStore.ts'

/**
 * Floating toggle for the full-screen map view (Factorio's `M`, and a button near the minimap). The
 * map promotes the corner minimap to a whole-viewport overview: every entity plotted at map scale,
 * the camera viewport as a "you are here" box, click-to-glide, drag-to-pan and wheel-to-zoom (all in
 * the renderer). Purely a view toggle — the renderer draws it read-only and never mutates the sim.
 *
 * `M` toggles; `Esc` leaves the map. A bare `M` is the map; `Shift+M` stays mute (handled in the boot
 * loop), so the two never collide. Guarded against firing while typing or in a modifier combo.
 */
export function MapView(): React.JSX.Element {
  const { on } = useSyncExternalStore(mapModeStore.subscribe, mapModeStore.get, mapModeStore.get)

  // `M` toggles; Esc-to-leave is owned by the central modal stack (modalStore).
  useModal('map', on, () => mapModeStore.set(false))
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
      // A bare M toggles the map; Shift+M is left to the sound-mute handler. Ctrl/Cmd+M are the OS's.
      if ((e.key === 'm' || e.key === 'M') && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        if (appStore.get().phase !== 'playing') return
        e.preventDefault()
        mapModeStore.toggle()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <button
      className={`overlay-btn map-btn glass${on ? ' active' : ''}`}
      onClick={() => mapModeStore.toggle()}
      title="Full-screen map (M)"
      aria-label="Full-screen map"
      aria-pressed={on}
    >
      <Icon name="Map" size={16} />
      <span>Map</span>
    </button>
  )
}
